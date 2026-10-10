import { test } from "node:test";
import { deepStrictEqual, rejects, strictEqual, throws, doesNotMatch, notStrictEqual } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";

import { createSupabaseWorkspaceResolver, startSupabaseCalibrationApi as startApi, validateTenantWorkspaces } from "../dist/calibration/supabase-auth.js";
const startSupabaseCalibrationApi = (options) => startApi({ allowUnisolatedLocal: true, ...options });
import { startCalibrationUi } from "../dist/calibration/http-server.js";
import { createLocalStore } from "../dist/calibration/ports.js";
import { fingerprintConfiguration } from "../dist/calibration/fingerprint.js";
import { fakeBridge, fakeCanonicalProfilePort, makeApplication } from "./calibration-api.test.mjs";

const authConfig = { url: "https://test-project.supabase.co", publishableKey: "sb_publishable_offline_test" };
const userA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const userB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const request = (token) => ({ headers: { ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) } });

function simulatedSupabase() {
  const members = new Map([["alice", { id: "workspace-a", tenant_id: "tenant-a" }],
    ["bob", { id: "workspace-b", tenant_id: "tenant-b" }]]);
  const calls = [];
  return { members, calls, fetch: async (url, options) => {
    const path = new URL(url);
    strictEqual(path.origin, authConfig.url);
    strictEqual(options.headers.apikey, authConfig.publishableKey);
    strictEqual(options.redirect, "error");
    const token = options.headers.authorization.replace("Bearer ", "");
    calls.push({ path: path.pathname, token });
    if (!["alice", "bob"].includes(token)) return Response.json({}, { status: 401 });
    if (path.pathname === "/auth/v1/user") return Response.json({ id: token === "alice" ? userA : userB,
      role: "authenticated", is_anonymous: false, email_confirmed_at: "2026-10-09T00:00:00Z",
      user_metadata: { tenant_id: "tenant-b", workspaceId: "workspace-b" } });
    strictEqual(path.pathname, "/rest/v1/calibration_workspaces");
    strictEqual(path.searchParams.get("select"), "id,tenant_id");
    strictEqual(path.searchParams.get("limit"), "2");
    return Response.json(members.has(token) ? [members.get(token)] : []);
  } };
}

test("Supabase resolves verified identity and fresh membership, never client metadata", async () => {
  const supabase = simulatedSupabase();
  const apps = [{ tenantId: "tenant-a", workspaceId: "workspace-a", application: { name: "a" } },
    { tenantId: "tenant-b", workspaceId: "workspace-b", application: { name: "b" } }];
  const resolve = createSupabaseWorkspaceResolver({ ...authConfig, fetch: supabase.fetch }, apps);
  apps[0].tenantId = "forged";
  const results = await Promise.all([resolve(request("alice")), resolve(request("bob"))]);
  deepStrictEqual(results.map((result) => result.workspaceId), ["workspace-a", "workspace-b"]);
  deepStrictEqual(results.map((result) => result.identity), [
    { userId: userA, tenantId: "tenant-a" }, { userId: userB, tenantId: "tenant-b" },
  ]);
  supabase.members.delete("alice");
  await rejects(resolve(request("alice")), (error) => error.status === 403);
  strictEqual(supabase.calls.filter((call) => call.token === "alice").length, 4);
});

test("invalid, anonymous, unconfirmed, unavailable and ambiguous auth fail closed", async (t) => {
  const app = new Proxy({}, { get() { throw new Error("unexpected business IO"); } });
  const configs = [{ tenantId: "tenant-a", workspaceId: "workspace-a", application: app }];
  const goodUser = { id: userA, role: "authenticated", is_anonymous: false, email_confirmed_at: "confirmed" };
  for (const [name, user, rows, expected] of [
    ["anonymous", { ...goodUser, is_anonymous: true }, [], 401],
    ["unconfirmed", { ...goodUser, email_confirmed_at: null }, [], 401],
    ["malformed user", { id: "forged" }, [], 401],
    ["missing membership", goodUser, [], 403],
    ["ambiguous", goodUser, [{ id: "workspace-a", tenant_id: "tenant-a" }, { id: "workspace-b", tenant_id: "tenant-b" }], 403],
    ["owner mismatch", goodUser, [{ id: "workspace-a", tenant_id: "tenant-b" }], 403],
    ["unprovisioned", goodUser, [{ id: "foreign", tenant_id: "tenant-a" }], 403],
    ["malformed membership", goodUser, { id: "workspace-a" }, 403],
  ]) await t.test(name, async () => {
    const resolve = createSupabaseWorkspaceResolver({ ...authConfig,
      fetch: async (url) => Response.json(new URL(url).pathname === "/auth/v1/user" ? user : rows) }, configs);
    await rejects(resolve(request("token")), (error) => error.status === expected);
  });
  for (const fakeFetch of [async () => { throw new Error("leaked bearer secret"); },
    async () => new Response("invalid JSON"), async () => Response.json({}, { status: 503 }),
    async () => Response.json({}, { status: 302 })]) {
    const resolve = createSupabaseWorkspaceResolver({ ...authConfig, fetch: fakeFetch }, configs);
    await rejects(resolve(request("token")), (error) => error.status === 503 && !error.message.includes("secret"));
  }
  const resolve = createSupabaseWorkspaceResolver({ ...authConfig, fetch: simulatedSupabase().fetch }, configs);
  for (const token of [undefined, "invalid", "expired", "tampered", "alice bob", "alice,bob"])
    await rejects(resolve(request(token)), (error) => error.status === 401);
});

test("auth configuration rejects elevated keys and credential redirect destinations", () => {
  for (const url of ["http://test-project.supabase.co", "https://evil.example", "https://test-project.supabase.co/path",
    "https://username@test-project.supabase.co", "https://test-project.supabase.co?redirect=evil", "https://test-project.supabase.co:444"])
    throws(() => createSupabaseWorkspaceResolver({ ...authConfig, url }, []));
  for (const publishableKey of ["sb_secret_private", "service_role", "eyJlegacy", ""])
    throws(() => createSupabaseWorkspaceResolver({ ...authConfig, publishableKey }, []));
});

test("malformed Host is handled before authentication without crashing the API", async (t) => {
  let authCalls = 0;
  const ui = await startCalibrationUi({
    resolveApplication: async () => { authCalls++; throw new Error("unexpected auth"); },
    closeApplications: async () => {},
  });
  t.after(() => ui.close());
  const status = await new Promise((resolve, reject) => {
    const outgoing = httpRequest(`${ui.url}/api/v1/bootstrap`, { headers: { host: "[" } }, (response) => {
      response.resume(); response.on("end", () => resolve(response.statusCode));
    });
    outgoing.on("error", reject); outgoing.end();
  });
  strictEqual(status, 400);
  strictEqual(authCalls, 0);
});

test("two protected accounts isolate corpus, consent, executions and profiles", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "supabase-two-accounts-"));
  const supabase = simulatedSupabase();
  const bridges = [fakeBridge(), fakeBridge()];
  const registry = ["a", "b"].map((suffix, index) => ({ tenantId: `tenant-${suffix}`,
    workspaceId: `workspace-${suffix}`, application: makeApplication({ repositories: createLocalStore(join(root, suffix)),
      configurationIdentity: fingerprintConfiguration({ tenantId: `tenant-${suffix}`, workspaceId: `workspace-${suffix}`,
        provider: "elevenlabs", stateDir: join(root, suffix) }, `private-provider-${suffix}`),
      bridge: bridges[index], canonical: fakeCanonicalProfilePort() }) }));
  const ui = await startCalibrationUi({ resolveApplication: createSupabaseWorkspaceResolver({ ...authConfig,
    fetch: supabase.fetch }, registry), closeApplications: async () => {} });
  t.after(async () => { await ui.close(); rmSync(root, { recursive: true, force: true }); });
  async function call(token, path, method = "GET", body, nonce, extra = {}) {
    const response = await fetch(`${ui.url}/api/v1/${path}`, { method, headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json",
      ...(nonce ? { "x-calibration-nonce": nonce } : {}), ...extra },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text();
    doesNotMatch(text, /private-provider|Bearer alice|Bearer bob/);
    return { status: response.status, body: JSON.parse(text) };
  }
  strictEqual((await call(null, "bootstrap")).status, 401);
  strictEqual(existsSync(join(root, "a", "workspaces")), false);
  const boots = await Promise.all([call("alice", "bootstrap"), call("bob", "bootstrap")]);
  deepStrictEqual(boots.map((boot) => boot.body.identity), [
    { userId: userA, tenantId: "tenant-a" }, { userId: userB, tenantId: "tenant-b" },
  ]);
  const nonces = boots.map((boot) => boot.body.sessionNonce);
  notStrictEqual(nonces[0], nonces[1]);
  strictEqual((await call("alice", "corpus?workspaceId=workspace-b")).status, 400);
  strictEqual((await call("alice", "corpus/draft", "PUT", { items: [] }, nonces[1], { "if-match": "0" })).status, 409);
  const runs = [];
  for (const [index, token] of ["alice", "bob"].entries()) {
    const nonce = nonces[index];
    const draft = (await call(token, "corpus/draft")).body;
    const saved = await call(token, "corpus/draft", "PUT", { ...draft,
      items: [{ id: "narration", order: 0, text: `Texte privé de ${token}.` }] }, nonce, { "if-match": String(draft.revision) });
    strictEqual(saved.status, 200);
    strictEqual((await call(token, "corpus/versions", "POST", { expectedRevision: saved.body.revision }, nonce)).status, 201);
    const proposal = await call(token, "calibration-runs/dry-run", "POST", { voiceRef: "same-voice", postproc: "cut",
      params: { model_id: "eleven_multilingual_v2", voice_settings: { stability: 0.65, similarity_boost: 0.75,
        style: 0, use_speaker_boost: true }, text_source: { kind: "inline", text: "ignored" },
        mode: "precision", language: "fr", runs: 3, dry_run: false } }, nonce);
    strictEqual(proposal.status, 201);
    runs.push(proposal.body);
    strictEqual((await call(token, `calibration-runs/${proposal.body.id}/execute`, "POST", {}, nonce)).status, 409);
    strictEqual(bridges[index].state.executions.length, 0);
    strictEqual((await call(token, `calibration-runs/${proposal.body.id}/approve`, "POST",
      { requestDigest: proposal.body.requestDigest }, nonce)).status, 200);
    strictEqual((await call(token, `calibration-runs/${proposal.body.id}/execute`, "POST", {}, nonce)).status, 200);
    strictEqual(bridges[index].state.executions.length, 1);
    strictEqual((await call(token, "voice-profiles", "POST", { runId: proposal.body.id }, nonce)).status, 201);
  }
  for (const [index, token] of ["alice", "bob"].entries()) {
    strictEqual((await call(token, `calibration-runs/${runs[1-index].id}`)).status, 404);
    strictEqual((await call(token, `calibration-runs/${runs[1-index].id}/execute`, "POST", {}, nonces[index])).status, 404);
    const bootstrap = (await call(token, "bootstrap")).body;
    strictEqual(bootstrap.recentRuns.length, 1);
    strictEqual(bootstrap.recentRuns[0].id, runs[index].id);
    strictEqual((await call(token, "voice-profiles")).body.length, 1);
    const corpus = JSON.stringify((await call(token, "corpus")).body);
    strictEqual(corpus.includes(token), true);
    strictEqual(corpus.includes(index === 0 ? "bob" : "alice"), false);
  }
  supabase.members.delete("alice");
  strictEqual((await call("alice", `calibration-runs/${runs[0].id}`)).status, 403);
  strictEqual((await call("alice", "voice-profiles")).status, 403);
  strictEqual(bridges[0].state.executions.length, 1);
});

test("registry refuses aliases and overlapping private paths before credential or process access", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "supabase-registry-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const a = { tenantId: "tenant-a", workspaceId: "workspace-a", dataDir: join(root, "a", "data"),
    stateDir: join(root, "a", "state"), wpmPath: join(root, "a", "wpm.json"), credentials: { env: { ELEVENLABS_API_KEY: "fake-a" } } };
  const b = { ...a, tenantId: "tenant-b", workspaceId: "workspace-b", dataDir: join(root, "b", "data"),
    stateDir: join(root, "b", "state"), wpmPath: join(root, "b", "wpm.json") };
  mkdirSync(join(root, "a"));
  const alias = join(root, "alias");
  symlinkSync(join(root, "a"), alias, process.platform === "win32" ? "junction" : "dir");
  for (const other of [{ ...b, dataDir: join(root, "a") }, { ...b, wpmPath: a.wpmPath },
    { ...b, dataDir: join(a.dataDir, "..private") },
    { ...b, wpmPath: `${a.wpmPath}.runs.jsonl` }, { ...b, wpmPath: `${a.wpmPath}.lock` },
    { ...b, wpmPath: join(root, "a", "runs.jsonl") },
    { ...b, stateDir: join(alias, "state") }, { ...b, workspaceId: a.workspaceId }])
    await rejects(startSupabaseCalibrationApi({ supabase: authConfig, workspaces: [a, other] }), /overlap|multiple registrations/);
  const fixed = validateTenantWorkspaces([a, b]);
  a.credentials.env.ELEVENLABS_API_KEY = "mutated";
  strictEqual(fixed[0].credentials.env.ELEVENLABS_API_KEY, "fake-a");
  mkdirSync(join(root, "b"));
  writeFileSync(b.wpmPath, "{}");
  symlinkSync(b.wpmPath, `${a.wpmPath}.runs.jsonl`);
  throws(() => validateTenantWorkspaces([a, b]), /sidecar escapes/);
});

test("protected entrypoint starts only authorized requested workspaces and validates Python identity before business IO", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "supabase-launcher-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const starts = { a: 0, b: 0 };
  const workspaces = ["a", "b"].map((suffix) => {
    const directory = join(root, suffix); mkdirSync(directory);
    const wpmPath = join(directory, "wpm.json"); writeFileSync(wpmPath, "{}");
    return { tenantId: `tenant-${suffix}`, workspaceId: `workspace-${suffix}`, dataDir: join(directory, "ui"),
      stateDir: join(directory, "state"), wpmPath, credentials: { env: { ELEVENLABS_API_KEY: `fake-${suffix}` } },
      mcpTransport: { async schema(secret) { starts[suffix]++; strictEqual(secret, `fake-${suffix}`); return { type: "object" }; },
        async callTool(name, args, secret) { strictEqual(secret, `fake-${suffix}`); strictEqual(name, "get_server_info");
          return { emitted: true, response: { tenant_id: `tenant-${suffix}`, workspace_id: `workspace-${suffix}`,
            state_dir: join(directory, "state") } }; }, async close() {} } };
  });
  const ui = await startSupabaseCalibrationApi({ supabase: { ...authConfig, fetch: simulatedSupabase().fetch }, workspaces });
  t.after(() => ui.close());
  deepStrictEqual(starts, { a: 0, b: 0 });
  strictEqual((await fetch(`${ui.url}/api/v1/bootstrap`)).status, 401);
  strictEqual((await fetch(`${ui.url}/api/v1/bootstrap`, { headers: { authorization: "Bearer invalid" } })).status, 401);
  deepStrictEqual(starts, { a: 0, b: 0 });
  const responses = await Promise.all(Array.from({ length: 8 }, () => fetch(`${ui.url}/api/v1/bootstrap`, {
    headers: { authorization: "Bearer alice" } })));
  deepStrictEqual(responses.map((response) => response.status), Array(8).fill(200));
  deepStrictEqual(starts, { a: 1, b: 0 });
  strictEqual((await fetch(`${ui.url}/api/v1/bootstrap`, { headers: { authorization: "Bearer bob" } })).status, 200);
  deepStrictEqual(starts, { a: 1, b: 1 });
  strictEqual((await fetch(`${ui.url}/`)).status, 401);
  const wrong = { ...workspaces[0], mcpTransport: { ...workspaces[0].mcpTransport,
    async callTool() { return { emitted: true, response: { tenant_id: "wrong", workspace_id: "workspace-a", state_dir: workspaces[0].stateDir } }; } } };
  const invalid = await startSupabaseCalibrationApi({ supabase: { ...authConfig, fetch: simulatedSupabase().fetch }, workspaces: [wrong] });
  t.after(() => invalid.close());
  strictEqual((await fetch(`${invalid.url}/api/v1/bootstrap`, { headers: { authorization: "Bearer alice" } })).status, 500);
  const changed = fingerprintConfiguration({ tenantId: "tenant-b", workspaceId: "workspace-a", provider: "elevenlabs" }, "same-key");
  notStrictEqual(changed, fingerprintConfiguration({ tenantId: "tenant-a", workspaceId: "workspace-a", provider: "elevenlabs" }, "same-key"));
});

test("lazy workspace factories never run for revoked, mismatched or unprovisioned memberships", async () => {
  let starts = 0;
  const supabase = simulatedSupabase();
  const resolve = createSupabaseWorkspaceResolver({ ...authConfig, fetch: supabase.fetch }, [{
    tenantId: "tenant-a", workspaceId: "workspace-a", application: async () => { starts++; return { name: "a" }; },
  }]);
  await rejects(resolve(request("bob")), (error) => error.status === 403);
  supabase.members.set("alice", { id: "workspace-a", tenant_id: "tenant-b" });
  await rejects(resolve(request("alice")), (error) => error.status === 403);
  supabase.members.delete("alice");
  await rejects(resolve(request("alice")), (error) => error.status === 403);
  strictEqual(starts, 0);
  supabase.members.set("alice", { id: "workspace-a", tenant_id: "tenant-a" });
  strictEqual((await resolve(request("alice"))).application.name, "a");
  strictEqual(starts, 1);
});
