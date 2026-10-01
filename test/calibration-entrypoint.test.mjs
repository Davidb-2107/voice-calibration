import { test } from "node:test";
import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCanonicalProfilePort } from "../dist/calibration/bridge.js";
import { findVaultRoot } from "../dist/calibration/credentials.js";
import { startVoiceCalibrationUi } from "../dist/calibration/entrypoint.js";
import { fingerprintConfiguration } from "../dist/calibration/fingerprint.js";
import { createLocalStore } from "../dist/calibration/local-store.js";

function instanceTransport(workspaceId, stateDir) {
  return {
    async schema() { return { type: "object" }; },
    async callTool() { return { response: { workspace_id: workspaceId, state_dir: stateDir }, emitted: true }; },
    async close() {},
  };
}

test("launcher canonicalizes state directory aliases before fingerprint and MCP binding", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "calibration-alias-"));
  const stateDir = join(root, "state");
  const alias = join(root, "alias");
  mkdirSync(stateDir);
  symlinkSync(stateDir, alias, process.platform === "win32" ? "junction" : "dir");
  const wpmPath = join(root, "wpm.json");
  writeFileSync(wpmPath, "{}");
  let ui;
  t.after(async () => { await ui?.close(); rmSync(root, { recursive: true, force: true }); });
  ui = await startVoiceCalibrationUi({
    workspaceId: "staging", stateDir: alias, dataDir: join(root, "ui"), wpmPath,
    credentials: { env: { ELEVENLABS_API_KEY: "test-key" } },
    mcpTransport: instanceTransport("staging", realpathSync.native(stateDir)),
  });
  strictEqual((await fetch(`${ui.url}/api/v1/bootstrap`)).status, 200);
});

test("historical launcher preserves v1 identity for a WPM path through a directory alias", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "calibration-legacy-alias-"));
  const sourceDir = join(root, "source");
  const alias = join(root, "alias");
  mkdirSync(sourceDir);
  writeFileSync(join(sourceDir, "wpm.json"), "{}");
  symlinkSync(sourceDir, alias, process.platform === "win32" ? "junction" : "dir");
  const wpmPath = join(alias, "wpm.json");
  const dataDir = join(root, "ui");
  const secret = "legacy-test-key";
  await createLocalStore(dataDir).runs.create({
    id: "legacy-run", workspaceId: "local-default", status: "running", idempotencyKey: "legacy-run",
    configurationIdentity: fingerprintConfiguration({ workspaceId: "local-default", provider: "elevenlabs", wpmPath }, secret),
    request: { voiceRef: "voice-test", params: {}, postproc: "cut" }, requestDigest: "legacy-digest",
    approval: null, reportId: null, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
  });
  let ui;
  t.after(async () => { await ui?.close(); rmSync(root, { recursive: true, force: true }); });
  ui = await startVoiceCalibrationUi({ dataDir, wpmPath, credentials: { env: { ELEVENLABS_API_KEY: secret } } });
  const bootstrap = await (await fetch(`${ui.url}/api/v1/bootstrap`)).json();
  strictEqual(bootstrap.recentRuns[0].status, "execution_unknown");
});

test("canonical corpus uses the same vault discovery as credentials outside the vault", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "calibration-entrypoint-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const corpusDir = join(vault, "Shared", "voice-calibration");
  mkdirSync(join(vault, "Projects"), { recursive: true });
  mkdirSync(corpusDir, { recursive: true });
  writeFileSync(join(corpusDir, "voice_wpm.json"), JSON.stringify({
    "voice-test": { observed_runs: [{ postproc: "raw", verified: true, words: 10, duration_s: 5 }] },
  }));

  const resolvedVault = findVaultRoot(join(root, "checkout"), vault);
  strictEqual(resolvedVault, vault);
  strictEqual(findVaultRoot(join(vault, "Projects", "consumer"), join(root, "missing")), vault);
  const canonical = createCanonicalProfilePort({ wpmPath: join(resolvedVault, "Shared", "voice-calibration", "voice_wpm.json") });
  const summary = await canonical.getObservationSummary();
  deepStrictEqual(summary, { sourceAvailable: true, voices: [{
    voiceRef: "voice-test", total: 1, raw: 1, rawClean: 1, trim: 0, cut: 0, other: 0, unknown: 0,
  }] });
});

test("explicit sources fail closed before storage is created", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "calibration-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const wpmPath = join(root, "wpm.json");
  const envFile = join(root, ".env");
  writeFileSync(wpmPath, "{}");
  const saved = process.env.ELEVENLABS_API_KEY;
  process.env.ELEVENLABS_API_KEY = "global-test-key";
  t.after(() => saved === undefined ? delete process.env.ELEVENLABS_API_KEY : process.env.ELEVENLABS_API_KEY = saved);
  const valid = { workspaceId: "workspace-a", dataDir, credentials: { env: { ELEVENLABS_API_KEY: "key-a" } }, wpmPath };
  const invalid = [
    { ...valid, credentials: undefined },
    { ...valid, wpmPath: undefined },
    { ...valid, credentials: null },
    { ...valid, credentials: {} },
    { ...valid, credentials: { env: null } },
    { ...valid, credentials: { env: {} } },
    { ...valid, credentials: { env: { ELEVENLABS_API_KEY: "  " } } },
    { ...valid, credentials: { env: { ELEVENLABS_API_KEY: "key-a" }, envFile } },
    { ...valid, credentials: { envFile: join(root, "missing.env") } },
    { ...valid, credentials: { envFile } },
    { ...valid, wpmPath: " " },
    { ...valid, wpmPath: join(root, "missing.json") },
    { ...valid, workspaceId: null },
    { ...valid, stateDir: " " },
    { ...valid, stateDir: null },
  ];
  for (const value of ["not json", "[]", "null", '{"voice":null}']) {
    const path = join(root, `bad-${invalid.length}.json`);
    writeFileSync(path, value);
    invalid.push({ ...valid, wpmPath: path });
  }
  for (const options of invalid) {
    await rejects(startVoiceCalibrationUi(options));
    strictEqual(existsSync(dataDir), false);
  }
});

test("public launchers keep separate WPM sources and snapshot caller inputs", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "calibration instances "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const savedCwd = process.cwd();
  const savedKey = process.env.ELEVENLABS_API_KEY;
  t.after(() => {
    process.chdir(savedCwd);
    if (savedKey === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = savedKey;
  });
  process.chdir(root);
  const pathA = join(root, "source a.json");
  const pathB = join(root, "source b.json");
  writeFileSync(pathA, JSON.stringify({ "voice-a": { observed_runs: [] } }));
  writeFileSync(pathB, JSON.stringify({ "voice-b": { observed_runs: [] } }));
  const envA = { ELEVENLABS_API_KEY: "key-a" };
  const envB = { ELEVENLABS_API_KEY: "key-b" };
  const originalFetch = globalThis.fetch;
  const keys = [];
  globalThis.fetch = (url, init) => {
    if (String(url).startsWith("https://api.elevenlabs.io/v1/voices/")) {
      keys.push(init.headers["xi-api-key"]);
      return Promise.resolve(Response.json({ voice_id: "voice-test", name: "Test voice" }));
    }
    return originalFetch(url, init);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const a = await startVoiceCalibrationUi({ workspaceId: "workspace-a", dataDir: join(root, "data-a"), credentials: { env: envA }, wpmPath: "source a.json", mcpTransport: instanceTransport("workspace-a", join(root, "data-a", "mcp")) });
  t.after(() => a.close());
  const b = await startVoiceCalibrationUi({ workspaceId: "workspace-b", dataDir: join(root, "data-b"), credentials: { env: envB }, wpmPath: pathB, mcpTransport: instanceTransport("workspace-b", join(root, "data-b", "mcp")) });
  t.after(() => b.close());
  envA.ELEVENLABS_API_KEY = "changed-a";
  envB.ELEVENLABS_API_KEY = "changed-b";
  process.env.ELEVENLABS_API_KEY = "global-conflict";
  process.chdir(savedCwd);
  for (const [ui, voice] of [[a, "voice-a"], [b, "voice-b"]]) {
    const response = await originalFetch(`${ui.url}/api/v1/bootstrap`);
    strictEqual(response.status, 200);
    const body = await response.json();
    strictEqual(body.config.configured, true);
    deepStrictEqual(body.observationSummary.voices.map((item) => item.voiceRef), [voice]);
    strictEqual(JSON.stringify(body).includes("key-"), false);
    const lookup = await originalFetch(`${ui.url}/api/v1/voices/${voice}`, {
      headers: { "x-calibration-nonce": body.sessionNonce },
    });
    strictEqual(lookup.status, 200);
    strictEqual((await lookup.json()).name, "Test voice");
  }
  deepStrictEqual(keys, ["key-a", "key-b"]);
});

test("launcher snapshots default environment before its first await", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "calibration-default-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const wpmPath = join(root, "wpm.json");
  writeFileSync(wpmPath, "{}");
  const savedKey = process.env.ELEVENLABS_API_KEY;
  const savedPath = process.env.VOICE_WPM_PATH;
  process.env.ELEVENLABS_API_KEY = "default-test-key";
  process.env.VOICE_WPM_PATH = wpmPath;
  t.after(() => {
    if (savedKey === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = savedKey;
    if (savedPath === undefined) delete process.env.VOICE_WPM_PATH;
    else process.env.VOICE_WPM_PATH = savedPath;
  });
  const starting = startVoiceCalibrationUi({ dataDir: join(root, "data") });
  delete process.env.ELEVENLABS_API_KEY;
  process.env.VOICE_WPM_PATH = join(root, "missing.json");
  const ui = await starting;
  t.after(() => ui.close());
  const response = await fetch(`${ui.url}/api/v1/bootstrap`);
  strictEqual(response.status, 200);
  const body = await response.json();
  strictEqual(body.config.configured, true);
  strictEqual(body.observationSummary.sourceAvailable, true);
});

test("an explicit env file selects only its key", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "calibration-file-"));
  const savedCwd = process.cwd();
  process.chdir(root);
  let ui;
  t.after(async () => {
    await ui?.close();
    process.chdir(savedCwd);
    rmSync(root, { recursive: true, force: true });
  });
  const envFile = join(root, "instance key.env");
  const wpmPath = join(root, "wpm.json");
  writeFileSync(envFile, "ELEVENLABS_API_KEY=file-test-key\nVOICE_WPM_PATH=wrong.json\n");
  writeFileSync(wpmPath, "{}");
  ui = await startVoiceCalibrationUi({
    workspaceId: "workspace-file", dataDir: join(root, "data"), credentials: { envFile: "instance key.env" }, wpmPath,
    mcpTransport: instanceTransport("workspace-file", join(root, "data", "mcp")),
  });
  const body = await (await fetch(`${ui.url}/api/v1/bootstrap`)).json();
  strictEqual(body.config.configured, true);
  strictEqual(body.observationSummary.sourceAvailable, true);
  strictEqual(JSON.stringify(body).includes("file-test-key"), false);
});

test("named launcher verifies the MCP binding and closes a rejected child before serving", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "calibration-binding-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const wpmPath = join(root, "wpm.json");
  writeFileSync(wpmPath, "{}");
  let closed = false;
  const transport = instanceTransport("production", join(root, "state"));
  transport.close = async () => { closed = true; };
  await rejects(startVoiceCalibrationUi({
    workspaceId: "staging", stateDir: join(root, "state"), dataDir: join(root, "ui"),
    credentials: { env: { ELEVENLABS_API_KEY: "test-key" } }, wpmPath, mcpTransport: transport,
  }), /MCP instance configuration mismatch/);
  strictEqual(closed, true);
  strictEqual(existsSync(join(root, "ui")), false);
});
