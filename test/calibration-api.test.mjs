import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deepStrictEqual, rejects, strictEqual, match, throws } from "node:assert";

import { createCalibrationApplication } from "../dist/calibration/application.js";
import { createCalibrationServer, startCalibrationUi } from "../dist/calibration/http-server.js";
import { startVoiceCalibrationUi } from "../dist/calibration/entrypoint.js";
import { createLocalStore } from "../dist/calibration/ports.js";
import { createCalibrationBridge } from "../dist/calibration/bridge.js";
import { createCredentialProvider } from "../dist/calibration/credentials.js";

const input = {
  workspaceId: "local-default",
  voiceRef: "voice-1",
  params: {
    model_id: "eleven_v3",
    voice_settings: { stability: 0.5, similarity_boost: 0.85, style: 0, use_speaker_boost: true },
    text_source: { kind: "inline", text: "caller supplied text must not replace the active corpus" },
    mode: "precision",
    language: "fr",
    runs: 3,
    dry_run: false,
  },
  postproc: "cut",
};

test("invalid workspace is rejected before application IO or server start", async () => {
  const touch = () => { throw new Error("unexpected IO"); };
  const repositories = {
    corpus: new Proxy({}, { get: () => touch }),
    runs: new Proxy({}, { get: () => touch }),
    profiles: new Proxy({}, { get: () => touch }),
    artifacts: new Proxy({}, { get: () => touch }),
  };
  const app = makeApplication({ repositories, bridge: fakeBridge(), canonical: fakeCanonicalProfilePort() });
  await rejects(app.getBootstrap("WORKSPACE-A"), /invalid workspaceId/);
  await rejects(app.getCorpus("WORKSPACE-A"), /invalid workspaceId/);
  await rejects(app.getDraft("WORKSPACE-A"), /invalid workspaceId/);
  await rejects(app.publishCorpusVersion("WORKSPACE-A", 0), /invalid workspaceId/);
  await rejects(app.listVoiceProfiles("WORKSPACE-A"), /invalid workspaceId/);
  await rejects(app.prepareDryRun({ ...input, workspaceId: "WORKSPACE-A" }), /invalid workspaceId/);
  await rejects(app.saveDraft("WORKSPACE-A", { workspaceId: "WORKSPACE-A", items: [] }, 0), /invalid workspaceId/);
  await rejects(app.saveDraft("workspace-a", { workspaceId: "WORKSPACE-A", items: [] }, 0), /invalid workspaceId/);
  await rejects(startCalibrationUi({ application: app, workspaceId: "WORKSPACE-A" }), /invalid workspaceId/);
  throws(() => createCalibrationServer({ application: app, workspaceId: "WORKSPACE-A" }), /invalid workspaceId/);
});

test("foreign MCP publication never verifies or saves a local profile", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "workspace-publication-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repositories = createLocalStore(root);
  await publishCorpus(repositories, "workspace-a");
  const seed = makeApplication({ repositories, bridge: fakeBridge(), canonical: fakeCanonicalProfilePort() });
  const run = await seed.prepareDryRun({ ...input, workspaceId: "workspace-a" });
  await seed.approve("workspace-a", run.id, { requestDigest: run.requestDigest });
  await seed.execute("workspace-a", run.id);
  const calls = [];
  const transport = {
    async schema() { return { type: "object" }; },
    async callTool(name) {
      calls.push(name);
      return { emitted: true, stderr: "", response: {
        run_id: run.id, workspace_id: "workspace-b", revision: 3, status: "succeeded",
        context: {}, request: {}, request_digest: "v1:sha256:test", proposal: {}, approval: null,
        result: { publication: { status: "published", canonical_ref: "python://wpm", wpm: 148 } },
        created_at: run.createdAt, updated_at: run.updatedAt,
      } };
    },
    async close() {},
  };
  const bridge = createCalibrationBridge({ transport, credentials: createCredentialProvider({
    env: { ELEVENLABS_API_KEY: "test-secret" },
  }) });
  const canonical = fakeCanonicalProfilePort();
  const app = makeApplication({ repositories, bridge, canonical });
  const before = snapshotFiles(root);
  await rejects(app.publishProfile("workspace-a", run.id), /calibration core workspace mismatch/);
  deepStrictEqual(calls, ["publish_calibration"]);
  strictEqual(canonical.calls.length, 0);
  strictEqual((await repositories.profiles.list("workspace-a")).length, 0);
  deepStrictEqual(snapshotFiles(root), before);
});

test("server rejects explicit null workspace without starting a listener", () => {
  throws(() => createCalibrationServer({ application: {}, workspaceId: null }), /invalid workspaceId/);
});

test("startup wrappers reject null before credentials, application IO or listener creation", async () => {
  const application = new Proxy({}, { get() { throw new Error("unexpected application IO"); } });
  await rejects(startCalibrationUi({ application, workspaceId: null, host: "0.0.0.0" }), /invalid workspaceId/);
  await rejects(startVoiceCalibrationUi({ workspaceId: null, host: "0.0.0.0" }), /invalid workspaceId/);
});

test("omitted and undefined startup workspace preserve local-default", async (t) => {
  const seen = [];
  const application = { async getBootstrap(workspaceId) { seen.push(workspaceId); return {}; }, async close() {} };
  for (const supplied of [{}, { workspaceId: undefined }]) {
    const server = createCalibrationServer({ application, ...supplied });
    strictEqual(server.listening, false);
    const ui = await startCalibrationUi({ application, ...supplied });
    t.after(() => ui.close());
    strictEqual((await fetch(`${ui.url}/api/v1/bootstrap`)).status, 200);
  }
  deepStrictEqual(seen, ["local-default", "local-default"]);
});

test("launcher rejects invalid workspace before creating credentials", async () => {
  await rejects(startVoiceCalibrationUi({ workspaceId: "WORKSPACE-A" }), /invalid workspaceId/);
});

test("HTTP returns invalid_workspace_id before application IO", async (t) => {
  const application = { getBootstrap() { throw new Error("unexpected IO"); }, async close() {} };
  const ui = await startCalibrationUi({ application, host: "127.0.0.1", port: 0 });
  t.after(() => ui.close());
  const response = await fetch(`${ui.url}/api/v1/bootstrap?workspaceId=WORKSPACE-A`);
  strictEqual(response.status, 400);
  deepStrictEqual(await response.json(), { error: { code: "invalid_workspace_id", message: "invalid workspaceId" } });
});

export function memoryRepositories() {
  const corpusByWorkspace = new Map();
  function corpusState(workspaceId) {
    let state = corpusByWorkspace.get(workspaceId);
    if (!state) {
      state = { draft: { workspaceId, revision: 0, items: [] }, activeVersion: null, versions: [] };
      corpusByWorkspace.set(workspaceId, state);
    }
    return state;
  }
  const runKey = (workspaceId, id) => JSON.stringify([workspaceId, id]);
  const runs = new Map();
  const profiles = [];
  const artifacts = new Map();
  let versionNumber = 1;

  return {
    corpus: {
      async getDraft(workspaceId) { return structuredClone(corpusState(workspaceId).draft); },
      async saveDraft(workspaceId, next, expectedRevision) {
        const { draft } = corpusState(workspaceId);
        if (expectedRevision !== draft.revision) throw new Error("revision conflict");
        draft.workspaceId = workspaceId;
        draft.revision += 1;
        draft.items = structuredClone(next.items);
        return structuredClone(draft);
      },
      async publishDraft(workspaceId, expectedRevision) {
        const state = corpusState(workspaceId);
        const { draft, versions, activeVersion } = state;
        if (expectedRevision !== draft.revision) throw new Error("revision conflict");
        const version = {
          id: `version-${versionNumber++}`,
          workspaceId,
          revision: draft.revision,
          items: structuredClone(draft.items),
          contentDigest: `corpus-${draft.revision}`,
          status: "active",
          publishedAt: "2026-09-02T10:00:00.000Z",
        };
        if (activeVersion) activeVersion.status = "superseded";
        state.activeVersion = version;
        versions.push(version);
        return structuredClone(version);
      },
      async getActiveVersion(workspaceId) { return structuredClone(corpusState(workspaceId).activeVersion); },
      async listVersions(workspaceId) { return structuredClone(corpusState(workspaceId).versions); },
    },
    runs: {
      async create(run) { runs.set(runKey(run.workspaceId, run.id), structuredClone(run)); },
      async get(workspaceId, id) { return structuredClone(runs.get(runKey(workspaceId, id)) ?? null); },
      async save(run) { runs.set(runKey(run.workspaceId, run.id), structuredClone(run)); },
      async list(workspaceId) { return [...runs.values()].filter((run) => run.workspaceId === workspaceId).map((run) => structuredClone(run)); },
      async recoverRunning(workspaceId, runId, recoveredAt) {
        const run = runs.get(runKey(workspaceId, runId));
        if (!run) return null;
        if (run.status !== "running") return structuredClone(run);
        const recovered = { ...run, status: "execution_unknown", updatedAt: recoveredAt };
        runs.set(runKey(workspaceId, runId), structuredClone(recovered));
        return structuredClone(recovered);
      },
    },
    profiles: {
      async list(workspaceId) { return profiles.filter((profile) => profile.workspaceId === workspaceId).map((profile) => structuredClone(profile)); },
      async publish(profile) { profiles.push(structuredClone(profile)); },
    },
    artifacts: {
      async put(workspaceId, runId, name, bytes) {
        const ref = `artifact://${workspaceId}/${runId}/${name}`;
        artifacts.set(ref, new Uint8Array(bytes));
        return ref;
      },
      async get(workspaceId, ref) {
        if (!ref.startsWith(`artifact://${workspaceId}/`)) throw new Error("invalid artifact reference");
        if (!artifacts.has(ref)) throw new Error("artifact not found");
        return new Uint8Array(artifacts.get(ref));
      },
    },
  };
}

export function fakeBridge(options = {}) {
  const state = {
    schema: options.schema ?? {
      type: "object",
      additionalProperties: false,
      properties: {
        language: { type: "string", default: "fr" },
        postproc: { type: "string", enum: ["cut", "trim"] },
      },
    },
    dryRuns: [],
    executions: [],
  };
  return {
    state,
    async getSchema() { return state.schema; },
    async dryRun(request) {
      state.dryRuns.push(structuredClone(request));
      if (options.dryRunError) throw new Error(options.dryRunError);
      return options.dryRun ?? { accepted: true, plan: [{ runId: request.runId }], raw: { status: "dry_run_success" } };
    },
    async execute(request) {
      state.executions.push(structuredClone(request));
      if (options.executeError) throw new Error(options.executeError);
      return options.execution ?? {
        status: "succeeded",
        metrics: { precision_stats: { median: 148, n: 3 } },
        artifacts: [],
        raw: { status: "ok", precision_stats: { median: 148, n: 3 } },
      };
    },
    async reconcile() { return { status: "unknown" }; },
  };
}

function coreGateBridge(workspaceId = "local-default") {
  const state = { calls: [], current: null };
  const schema = { type: "object", additionalProperties: false, properties: {} };
  const makeRecord = (request, status, requestDigest, approval = null, result = null) => ({
    runId: "core-run-1",
    workspaceId,
    revision: status === "dry_run_ready" ? 0 : status === "approved" ? 1 : 2,
    status,
    context: {
      corpus_version_id: request.corpusVersionId,
      corpus_digest: request.corpusDigest,
      contract_digest: request.contractDigest,
      core_digest: request.coreDigest,
    },
    request: { ...request.params, voice: request.voiceRef, postproc: request.postproc, dry_run: false },
    requestDigest,
    proposal: { status: "dry_run_success", requests_planned: 3 },
    approval,
    result,
    createdAt: "2026-09-03T10:00:00.000Z",
    updatedAt: "2026-09-03T10:00:00.000Z",
    raw: { status },
    requestSnapshot: structuredClone(request),
  });
  return {
    state,
    async getSchema() { return schema; },
    async propose(inputValue) {
      strictEqual(inputValue.workspaceId, workspaceId);
      state.calls.push({ operation: "propose", input: structuredClone(inputValue) });
      state.current = makeRecord(inputValue.request, "dry_run_ready", "v1:sha256:core-request");
      return {
        accepted: true,
        plan: [],
        raw: { status: "dry_run_success", requests_planned: 3 },
        status: state.current.status,
        runId: state.current.runId,
        workspaceId,
        requestDigest: state.current.requestDigest,
        proposal: state.current.proposal,
        approval: null,
      };
    },
    async approve(inputValue) {
      strictEqual(inputValue.workspaceId, workspaceId);
      state.calls.push({ operation: "approve", input: structuredClone(inputValue) });
      state.current = makeRecord(
        state.current.requestSnapshot,
        "approved",
        state.current.requestDigest,
        { approvedAt: "2026-09-03T10:00:00.000Z", expiresAt: "2026-09-03T10:15:00.000Z", consumedAt: null },
      );
      return state.current;
    },
    async getRun(inputValue) {
      strictEqual(inputValue.workspaceId, workspaceId);
      return state.current;
    },
    async execute(inputValue) {
      strictEqual(inputValue.workspaceId, workspaceId);
      state.calls.push({ operation: "execute", input: structuredClone(inputValue) });
      state.current = {
        ...state.current,
        status: "succeeded",
        approval: { ...state.current.approval, consumedAt: "2026-09-03T10:00:00.000Z" },
        result: { status: "ok", precision_stats: { median: 168, n: 3 } },
      };
      return {
        status: "succeeded",
        metrics: { precision_stats: { median: 168, n: 3 } },
        artifacts: [],
        raw: state.current.result,
        coreRun: state.current,
      };
    },
    async reconcile(inputValue) { strictEqual(inputValue.workspaceId, workspaceId); return state.current; },
  };
}

export function fakeCanonicalProfilePort(options = {}) {
  const calls = [];
  return {
    calls,
    async findPublished() { return options.published ?? null; },
    async ensurePublished(inputValue) {
      calls.push(structuredClone(inputValue));
      if (options.error) throw new Error(options.error);
      return { canonicalRef: options.canonicalRef ?? "python://voice_wpm/voice-1" };
    },
  };
}

const TEST_IDENTITY = "v1:hmac-sha256:" + "a".repeat(64);

export function makeApplication(options = {}) {
  return createCalibrationApplication({
    ...options,
    configurationIdentity: Object.hasOwn(options, "configurationIdentity")
      ? options.configurationIdentity : TEST_IDENTITY,
  });
}

async function publishCorpus(repositories, workspaceId = "local-default") {
  const draft = await repositories.corpus.getDraft(workspaceId);
  const saved = await repositories.corpus.saveDraft(
    workspaceId,
    { ...draft, items: [{ id: "one", order: 1, text: "Bonjour." }, { id: "two", order: 0, text: "Le monde." }] },
    draft.revision,
  );
  return repositories.corpus.publishDraft(workspaceId, saved.revision);
}

function snapshotFiles(root) {
  const snapshot = {};
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else snapshot[path] = readFileSync(path, "base64");
    }
  }
  visit(root);
  return snapshot;
}

test("run configuration blocks every mutation before bridge, canonical access or recovery", async (t) => {
  const forbidden = () => { throw new Error("unexpected bridge or canonical access"); };
  const bridge = Object.fromEntries(["getSchema", "dryRun", "propose", "getRun", "approve", "execute", "reconcile", "publish"].map((name) => [name, forbidden]));
  const canonical = { findPublished: forbidden, ensurePublished: forbidden, getObservationSummary: () => ({}) };
  for (const [kind, status] of [
    ["mismatch", "succeeded"], ["missing", "succeeded"],
    ["mismatch", "running"], ["missing", "running"],
    ["mismatch", "execution_unknown"], ["missing", "execution_unknown"],
    ["mismatch", "core-backed"], ["missing", "core-backed"],
  ]) {
    await t.test(`${kind} ${status}`, async (part) => {
      const root = mkdtempSync(join(tmpdir(), "configuration-guard-"));
      part.after(() => rmSync(root, { recursive: true, force: true }));
      const repositories = createLocalStore(root);
      await publishCorpus(repositories);
      const seed = makeApplication({ repositories, bridge: fakeBridge(), canonical: fakeCanonicalProfilePort() });
      let run = await seed.prepareDryRun(input);
      run = await seed.approve(run.workspaceId, run.id, { requestDigest: run.requestDigest });
      run = await seed.execute(run.workspaceId, run.id);
      run = {
        ...run,
        status: status === "core-backed" ? "succeeded" : status,
        requestDigest: status === "core-backed" ? "v1:sha256:" + "c".repeat(64) : run.requestDigest,
      };
      if (kind === "missing") delete run.configurationIdentity;
      await repositories.runs.save(run);
      const before = snapshotFiles(root);
      const denied = makeApplication({
        repositories: createLocalStore(root), bridge, canonical,
        configurationIdentity: "v1:hmac-sha256:" + "b".repeat(64),
      });
      const expected = kind === "missing" ? "configuration_identity_missing" : "configuration_mismatch";
      const local = await denied.getRun(run.workspaceId, run.id);
      strictEqual(local.status, run.status);
      strictEqual((await denied.getReport(run.workspaceId, run.id)).runId, run.id);
      strictEqual((await denied.getBootstrap(run.workspaceId)).recentRuns.find((item) => item.id === run.id).status, run.status);
      for (const operation of [
        () => denied.approve(run.workspaceId, run.id, { requestDigest: run.requestDigest }),
        () => denied.execute(run.workspaceId, run.id),
        () => denied.reconcile(run.workspaceId, run.id),
        () => denied.publishProfile(run.workspaceId, run.id),
      ]) await rejects(operation(), (error) => error.code === expected);
      deepStrictEqual(snapshotFiles(root), before);
    });
  }
});

test("missing configuration cannot prepare and a forged HTTP identity cannot authorize a run", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "configuration-http-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repositories = createLocalStore(root);
  await publishCorpus(repositories);
  const bridge = fakeBridge();
  await rejects(makeApplication({ repositories, bridge, canonical: fakeCanonicalProfilePort(), configurationIdentity: undefined }).prepareDryRun(input), /configuration identity is unavailable/);
  strictEqual(bridge.state.dryRuns.length, 0);
  const app = makeApplication({ repositories, bridge, canonical: fakeCanonicalProfilePort() });
  const ui = await startCalibrationUi({ application: app, host: "127.0.0.1", port: 0 });
  t.after(() => ui.close());
  const nonce = (await (await fetch(`${ui.url}/api/v1/bootstrap`)).json()).sessionNonce;
  const headers = { "content-type": "application/json", "x-calibration-nonce": nonce };
  const response = await fetch(`${ui.url}/api/v1/calibration-runs/dry-run`, {
    method: "POST", headers,
    body: JSON.stringify({ ...input, configurationIdentity: "v1:hmac-sha256:" + "b".repeat(64) }),
  });
  strictEqual(response.status, 201);
  const run = await response.json();
  strictEqual(run.configurationIdentity, TEST_IDENTITY);
  const mismatched = makeApplication({ repositories, bridge: fakeBridge(), canonical: fakeCanonicalProfilePort(), configurationIdentity: "v1:hmac-sha256:" + "b".repeat(64) });
  const deniedUi = await startCalibrationUi({ application: mismatched, host: "127.0.0.1", port: 0 });
  t.after(() => deniedUi.close());
  const deniedNonce = (await (await fetch(`${deniedUi.url}/api/v1/bootstrap`)).json()).sessionNonce;
  const deniedHeaders = { "content-type": "application/json", "x-calibration-nonce": deniedNonce };
  for (const [path, requestBody] of [
    [`calibration-runs/${run.id}/approve`, { requestDigest: run.requestDigest, configurationIdentity: "v1:hmac-sha256:" + "b".repeat(64) }],
    [`calibration-runs/${run.id}/execute`, {}],
    [`calibration-runs/${run.id}/reconcile`, {}],
    ["voice-profiles", { runId: run.id }],
  ]) {
    const result = await fetch(`${deniedUi.url}/api/v1/${path}`, { method: "POST", headers: deniedHeaders, body: JSON.stringify(requestBody) });
    strictEqual(result.status, 409);
    strictEqual((await result.json()).error.code, "configuration_mismatch");
  }
  strictEqual((await fetch(`${deniedUi.url}/api/v1/calibration-runs/${run.id}`)).status, 200);
  const legacy = { ...run };
  delete legacy.configurationIdentity;
  await repositories.runs.save(legacy);
  const missingResponse = await fetch(`${deniedUi.url}/api/v1/calibration-runs/${run.id}/approve`, {
    method: "POST", headers: deniedHeaders, body: JSON.stringify({ requestDigest: run.requestDigest }),
  });
  strictEqual(missingResponse.status, 409);
  strictEqual((await missingResponse.json()).error.code, "configuration_identity_missing");
  throws(() => makeApplication({ repositories, bridge, canonical: fakeCanonicalProfilePort(), configurationIdentity: "bad" }), /invalid configurationIdentity/);
});

test("foreign first request does not recover local runs", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "workspace-restart-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repositories = createLocalStore(root);
  const seed = makeApplication({ repositories, bridge: fakeBridge(), canonical: fakeCanonicalProfilePort() });
  for (const workspaceId of ["workspace-a", "workspace-b"]) await publishCorpus(repositories, workspaceId);
  const runA = await seed.prepareDryRun({ ...input, workspaceId: "workspace-a" });
  const approved = await seed.approve("workspace-a", runA.id, { requestDigest: runA.requestDigest });
  await repositories.runs.save({ ...approved, status: "running", approval: {
    ...approved.approval, consumedAt: "2026-09-02T10:00:00Z",
  } });
  const runB = await seed.prepareDryRun({ ...input, workspaceId: "workspace-b" });
  const bridge = fakeBridge();
  const canonical = fakeCanonicalProfilePort();
  const app = makeApplication({ repositories: createLocalStore(root), bridge, canonical });
  const ui = await startCalibrationUi({ application: app, workspaceId: "workspace-a" });
  t.after(() => ui.close());
  const before = snapshotFiles(root);
  const headers = { "content-type": "application/json", "x-calibration-nonce": app.getSessionNonce() };
  const requests = [
    ["GET", `/calibration-runs/${runB.id}`, undefined],
    ["POST", `/calibration-runs/${runB.id}/approve`, { requestDigest: runB.requestDigest }],
    ["POST", `/calibration-runs/${runB.id}/execute`, {}],
    ["POST", `/calibration-runs/${runB.id}/reconcile`, {}],
    ["POST", "/voice-profiles", { runId: runB.id }],
  ];
  for (const [method, path, value] of requests) {
    const response = await fetch(`${ui.url}/api/v1${path}`, {
      method, headers, ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
    strictEqual(response.status, 404);
    deepStrictEqual(snapshotFiles(root), before);
  }
  strictEqual(bridge.state.dryRuns.length, 0);
  strictEqual(bridge.state.executions.length, 0);
  strictEqual(canonical.calls.length, 0);
  strictEqual(await app.getRun("workspace-a", runB.id), null);
  strictEqual(await app.getReport("workspace-a", runB.id), null);
  for (const operation of [
    () => app.approve("workspace-a", runB.id, { requestDigest: runB.requestDigest }),
    () => app.execute("workspace-a", runB.id),
    () => app.reconcile("workspace-a", runB.id),
    () => app.publishProfile("workspace-a", runB.id),
  ]) {
    await rejects(operation(), { name: "NotFoundError" });
    deepStrictEqual(snapshotFiles(root), before);
  }
  for (const operation of [
    () => app.getRun("WORKSPACE-A", runB.id),
    () => app.getReport("WORKSPACE-A", runB.id),
    () => app.approve("WORKSPACE-A", runB.id, { requestDigest: runB.requestDigest }),
    () => app.execute("WORKSPACE-A", runB.id),
    () => app.reconcile("WORKSPACE-A", runB.id),
    () => app.publishProfile("WORKSPACE-A", runB.id),
  ]) {
    await rejects(operation(), /invalid workspaceId/);
    deepStrictEqual(snapshotFiles(root), before);
  }
  const badRepositories = memoryRepositories();
  badRepositories.runs.get = async () => structuredClone(runB);
  badRepositories.runs.list = async () => { throw new Error("unexpected recovery"); };
  const badApp = makeApplication({ repositories: badRepositories, bridge, canonical });
  strictEqual(await badApp.getRun("workspace-a", runB.id), null);
  strictEqual(await badApp.getReport("workspace-a", runB.id), null);
  const allowed = await fetch(`${ui.url}/api/v1/calibration-runs/${runA.id}`);
  strictEqual(allowed.status, 200);
  strictEqual((await allowed.json()).status, "execution_unknown");
});

test("HTTP checks every supplied workspace identity", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "workspace-http-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bridge = fakeBridge();
  const app = makeApplication({ repositories: createLocalStore(root), bridge, canonical: fakeCanonicalProfilePort() });
  const ui = await startCalibrationUi({ application: app, workspaceId: "workspace-a" });
  t.after(() => ui.close());
  const headers = { "content-type": "application/json", "x-calibration-nonce": app.getSessionNonce() };
  const before = snapshotFiles(root);
  const cases = [
    ["GET", "/bootstrap?workspaceId=WORKSPACE-A", undefined, "invalid_workspace_id"],
    ["GET", "/bootstrap?workspaceId=workspace-b", undefined, "workspace_mismatch"],
    ["GET", "/bootstrap?workspaceId=workspace-a&workspaceId=workspace-b", undefined, "workspace_mismatch"],
    ["POST", "/calibration-runs/dry-run", { workspaceId: "workspace-b" }, "workspace_mismatch"],
    ["POST", "/calibration-runs/dry-run", { input: { workspaceId: "workspace-b" } }, "workspace_mismatch"],
    ["PUT", "/corpus/draft", { draft: { workspaceId: "workspace-b" } }, "workspace_mismatch"],
    ["POST", "/voice-profiles", { workspaceId: null }, "invalid_workspace_id"],
  ];
  for (const [method, path, value, code] of cases) {
    const response = await fetch(`${ui.url}/api/v1${path}`, {
      method, headers: { ...headers, "if-match": 'W/"corpus-draft-0"' },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
    strictEqual(response.status, 400);
    strictEqual((await response.json()).error.code, code);
    deepStrictEqual(snapshotFiles(root), before);
  }
  for (const action of ["approve", "execute", "reconcile"]) {
    const response = await fetch(`${ui.url}/api/v1/calibration-runs/foreign/${action}`, {
      method: "POST", headers, body: JSON.stringify({ workspaceId: "workspace-b" }),
    });
    strictEqual(response.status, 400);
    strictEqual((await response.json()).error.code, "workspace_mismatch");
    deepStrictEqual(snapshotFiles(root), before);
  }
  const shadowed = await fetch(`${ui.url}/api/v1/calibration-runs/dry-run?workspaceId=workspace-a`, {
    method: "POST", headers,
    body: JSON.stringify({ workspaceId: "workspace-a", input: { workspaceId: "workspace-b" } }),
  });
  strictEqual(shadowed.status, 400);
  strictEqual((await shadowed.json()).error.code, "workspace_mismatch");
  deepStrictEqual(snapshotFiles(root), before);
  strictEqual((await fetch(`${ui.url}/api/v1/bootstrap?workspaceId=workspace-a`)).status, 200);
  strictEqual(bridge.state.dryRuns.length, 0);
  strictEqual(bridge.state.executions.length, 0);
});

test("server retains its workspace after caller mutates options", async (t) => {
  const seen = [];
  const application = { async getBootstrap(workspaceId) { seen.push(workspaceId); return {}; } };
  const options = { application, workspaceId: "workspace-a" };
  const server = createCalibrationServer(options);
  options.workspaceId = "workspace-b";
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  strictEqual((await fetch(`http://127.0.0.1:${server.address().port}/api/v1/bootstrap`)).status, 200);
  deepStrictEqual(seen, ["workspace-a"]);
});

test("the application requires a persistent run listing repository", () => {
  const repositories = memoryRepositories();
  delete repositories.runs.list;
  throws(
    () => makeApplication({ repositories, bridge: fakeBridge(), canonical: fakeCanonicalProfilePort() }),
    /runs\.list is required/,
  );
});

test("bootstrap reloads recent runs from persistent storage after an application restart", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "calibration-restart-"));
  try {
    const repositories = createLocalStore(dataDir);
    await publishCorpus(repositories);
    const run = await makeApplication({
      repositories,
      bridge: fakeBridge(),
      canonical: fakeCanonicalProfilePort(),
    }).prepareDryRun(input);

    const restarted = makeApplication({
      repositories: createLocalStore(dataDir),
      bridge: fakeBridge(),
      canonical: fakeCanonicalProfilePort(),
    });
    const bootstrap = await restarted.getBootstrap();
    strictEqual(bootstrap.recentRuns.some((candidate) => candidate.id === run.id), true);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("persists the accepted proposal preview across an application restart", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "calibration-proposal-"));
  try {
    const repositories = createLocalStore(dataDir);
    await publishCorpus(repositories);
    const bridge = fakeBridge({
      dryRun: {
        accepted: true,
        plan: [{ slug: "precision-01", characters: 42 }],
        raw: { status: "dry_run_success", billable_characters: 126, estimated_cost_usd: 0.0126 },
      },
    });
    const run = await makeApplication({
      repositories,
      bridge,
      canonical: fakeCanonicalProfilePort(),
    }).prepareDryRun(input);

    strictEqual(run.status, "dry_run_ready");
    deepStrictEqual(run.proposal, {
      accepted: true,
      plan: [{ slug: "precision-01", characters: 42 }],
      raw: { status: "dry_run_success", billable_characters: 126, estimated_cost_usd: 0.0126 },
    });

    const restarted = makeApplication({
      repositories: createLocalStore(dataDir),
      bridge: fakeBridge(),
      canonical: fakeCanonicalProfilePort(),
    });
    const persisted = await restarted.getRun("local-default", run.id);
    deepStrictEqual(persisted?.proposal, run.proposal);
    strictEqual(persisted?.status, "dry_run_ready");
    await rejects(restarted.execute("local-default", run.id), /approval required/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("bootstrap recovers persisted running runs as execution_unknown", async () => {
  const repositories = memoryRepositories();
  await publishCorpus(repositories);
  const app = makeApplication({ repositories, bridge: fakeBridge(), canonical: fakeCanonicalProfilePort() });
  const run = await app.prepareDryRun(input);
  const approved = await app.approve("local-default", run.id, { requestDigest: run.requestDigest });
  await repositories.runs.save({
    ...approved,
    status: "running",
    approval: { ...approved.approval, consumedAt: "2026-09-02T10:00:00.000Z" },
  });

  const restarted = makeApplication({ repositories, bridge: fakeBridge(), canonical: fakeCanonicalProfilePort() });
  const bootstrap = await restarted.getBootstrap();
  strictEqual(bootstrap.recentRuns.find((candidate) => candidate.id === run.id)?.status, "execution_unknown");
  strictEqual((await repositories.runs.get("local-default", run.id)).status, "execution_unknown");
});

test("persisted error reports redact the exact provider credential", async () => {
  const repositories = memoryRepositories();
  await publishCorpus(repositories);
  const secret = "sk-live-calibration-secret";
  const credentials = {
    async status() { return { configured: true }; },
    async forRun() { return { provider: "elevenlabs", secret }; },
    redact(value) { return typeof value === "string" ? value.split(secret).join("[REDACTED]") : value; },
  };
  const app = makeApplication({
    repositories,
    bridge: fakeBridge({ executeError: `provider failed with ${secret}` }),
    canonical: fakeCanonicalProfilePort(),
    credentials,
  });
  const run = await app.prepareDryRun(input);
  await app.approve("local-default", run.id, { requestDigest: run.requestDigest });
  await app.execute("local-default", run.id);
  const report = await app.getReport("local-default", run.id);
  strictEqual(JSON.stringify(report).includes(secret), false);
  strictEqual(report.error.message.includes("[REDACTED]"), true);
});

test("HTTP responses redact sensitive values inside JSON-shaped strings", async (t) => {
  const repositories = memoryRepositories();
  await publishCorpus(repositories);
  const secret = "quoted-provider-secret";
  const app = makeApplication({
    repositories,
    bridge: fakeBridge({
      execution: {
        status: "succeeded",
        metrics: {},
        artifacts: [],
        raw: { details: `{"api_key":"${secret}"}` },
      },
    }),
    canonical: fakeCanonicalProfilePort(),
  });
  const run = await app.prepareDryRun(input);
  await app.approve("local-default", run.id, { requestDigest: run.requestDigest });
  await app.execute("local-default", run.id);
  const ui = await startCalibrationUi({ application: app, host: "127.0.0.1", port: 0 });
  t.after(async () => ui.close());

  const response = await fetch(`${ui.url}/api/v1/calibration-runs/${run.id}`);
  const body = await response.json();
  strictEqual(JSON.stringify(body).includes(secret), false);
  strictEqual(JSON.stringify(body).includes("[REDACTED]"), true);
});

test("prepareDryRun refuses calibration without an active published corpus", async () => {
  const bridge = fakeBridge();
  const app = makeApplication({ repositories: memoryRepositories(), bridge, canonical: fakeCanonicalProfilePort() });
  await rejects(app.prepareDryRun(input), /active published corpus/);
  strictEqual(bridge.state.dryRuns.length, 0);
});

test("prepareDryRun refuses a voice with an existing canonical calibration before any provider proposal", async () => {
  const repositories = memoryRepositories();
  await publishCorpus(repositories);
  const bridge = fakeBridge();
  const app = makeApplication({
    repositories,
    bridge,
    canonical: fakeCanonicalProfilePort({
      published: { canonicalRef: "python://voice_wpm/voice-1", wpm: 172.5 },
    }),
  });

  await rejects(app.prepareDryRun(input), /déjà un calibrage publié/i);
  strictEqual(bridge.state.dryRuns.length, 0);
});

test("prepareDryRun refuses a second pending calibration for the same voice", async () => {
  const repositories = memoryRepositories();
  await publishCorpus(repositories);
  const bridge = fakeBridge();
  const app = makeApplication({ repositories, bridge, canonical: fakeCanonicalProfilePort() });

  await app.prepareDryRun(input);
  await rejects(app.prepareDryRun(input), /calibrage est déjà en cours/i);
  strictEqual(bridge.state.dryRuns.length, 1);
});

test("the backend fixes MVP precision calibration to five runs", async () => {
  const repositories = memoryRepositories();
  await publishCorpus(repositories);
  const bridge = fakeBridge();
  const app = makeApplication({ repositories, bridge, canonical: fakeCanonicalProfilePort() });

  const run = await app.prepareDryRun(input);

  strictEqual(run.request.params.runs, 5);
  strictEqual(bridge.state.dryRuns[0].request.params.runs, 5);
});

test("the application projects the persistent core gate and never runs a second local workflow", async () => {
  const repositories = memoryRepositories();
  await publishCorpus(repositories);
  const bridge = coreGateBridge();
  const app = makeApplication({ repositories, bridge, canonical: fakeCanonicalProfilePort() });

  const run = await app.prepareDryRun(input);
  strictEqual(run.id, "core-run-1");
  strictEqual(run.status, "dry_run_ready");
  strictEqual(run.requestDigest, "v1:sha256:core-request");
  strictEqual(run.configurationIdentity, TEST_IDENTITY);
  strictEqual(bridge.state.calls[0].operation, "propose");

  const approved = await app.approve("local-default", run.id, { requestDigest: run.requestDigest });
  strictEqual(approved.status, "approved");
  strictEqual(approved.configurationIdentity, TEST_IDENTITY);
  strictEqual(bridge.state.calls[1].operation, "approve");

  const executed = await app.execute("local-default", run.id);
  strictEqual(executed.status, "succeeded");
  strictEqual(executed.configurationIdentity, TEST_IDENTITY);
  strictEqual((await app.getRun("local-default", run.id)).configurationIdentity, TEST_IDENTITY);
  strictEqual(bridge.state.calls[2].operation, "execute");
  strictEqual(bridge.state.calls[2].input.coreRunId, "core-run-1");
  strictEqual(bridge.state.calls[2].input.workspaceId, "local-default");
});

test("the application preserves the resolved snapshot through approval, execution and explicit profile publication", async () => {
  const repositories = memoryRepositories();
  await publishCorpus(repositories);
  let now = new Date("2026-09-02T10:00:00.000Z");
  const bridge = fakeBridge();
  const canonical = fakeCanonicalProfilePort();
  const app = makeApplication({ repositories, bridge, canonical, clock: { now: () => now } });

  const run = await app.prepareDryRun(input);
  strictEqual(run.status, "dry_run_ready");
  strictEqual(run.request.params.corpus_key, "voice-1");
  deepStrictEqual(run.request.params.text_source, { kind: "inline", text: "Le monde.\n\nBonjour." });
  match(run.requestDigest, /^[a-f0-9]{64}$/);
  strictEqual(bridge.state.dryRuns.length, 1);
  await rejects(app.approve("local-default", run.id, { requestDigest: "wrong-digest" }), /request digest mismatch/);

  const approved = await app.approve("local-default", run.id, { requestDigest: run.requestDigest });
  strictEqual(approved.status, "approved");
  strictEqual(approved.approval.expiresAt, "2026-09-02T10:15:00.000Z");

  const result = await app.execute("local-default", run.id);
  strictEqual(result.status, "succeeded");
  strictEqual(result.approval.consumedAt, "2026-09-02T10:00:00.000Z");
  strictEqual(bridge.state.executions.length, 1);
  deepStrictEqual(bridge.state.executions[0].snapshot, run.request);
  strictEqual((await app.listVoiceProfiles()).length, 0);
  const profile = await app.publishProfile("local-default", run.id);
  strictEqual(profile.wpmSnapshot, 148);
  strictEqual(profile.canonicalRef, "python://voice_wpm/voice-1");
  strictEqual((await app.listVoiceProfiles("local-default")).length, 1);
  strictEqual(canonical.calls.length, 1);
  now = new Date("2026-09-02T10:01:00.000Z");
});

test("core publication commits the canonical corpus before the local profile", async () => {
  const repositories = memoryRepositories();
  await publishCorpus(repositories);
  const bridge = fakeBridge();
  const publicationCalls = [];
  bridge.publish = async (inputValue) => {
    publicationCalls.push(structuredClone(inputValue));
    return { canonicalRef: "python://voice_wpm/voice-1", wpm: 149, runsPublished: 3 };
  };
  const canonical = fakeCanonicalProfilePort();
  const app = makeApplication({ repositories, bridge, canonical });
  const run = await app.prepareDryRun(input);
  await app.approve("local-default", run.id, { requestDigest: run.requestDigest });
  await app.execute("local-default", run.id);

  const profile = await app.publishProfile("local-default", run.id);

  strictEqual(publicationCalls.length, 1);
  strictEqual(publicationCalls[0].workspaceId, "local-default");
  strictEqual(publicationCalls[0].runId, run.id);
  strictEqual(canonical.calls[0].wpm, 149);
  strictEqual(profile.wpmSnapshot, 149);
});

test("execution consumes approval before a lost response and never retries execution_unknown", async () => {
  const repositories = memoryRepositories();
  await publishCorpus(repositories);
  const bridge = fakeBridge({ executeError: "execution_unknown" });
  const app = makeApplication({ repositories, bridge, canonical: fakeCanonicalProfilePort() });
  const run = await app.prepareDryRun(input);
  await app.approve("local-default", run.id, { requestDigest: run.requestDigest });
  const unknown = await app.execute("local-default", run.id);
  strictEqual(unknown.status, "execution_unknown");
  strictEqual(unknown.approval.consumedAt !== null, true);
  strictEqual(bridge.state.executions.length, 1);
  await rejects(app.execute("local-default", run.id), /execution_unknown.*retry|retry.*execution_unknown/);
  strictEqual(bridge.state.executions.length, 1);
});

test("approval expires according to the injected clock", async () => {
  const repositories = memoryRepositories();
  await publishCorpus(repositories);
  let now = new Date("2026-09-02T10:00:00Z");
  const app = makeApplication({ repositories, bridge: fakeBridge(), canonical: fakeCanonicalProfilePort(), clock: { now: () => now } });
  const run = await app.prepareDryRun(input);
  await app.approve("local-default", run.id, { requestDigest: run.requestDigest });
  now = new Date("2026-09-02T10:16:00Z");
  await rejects(app.execute("local-default", run.id), /approval expired/);
});

test("the HTTP API enforces nonce, ETag, same-origin and safe static paths", async (t) => {
  const repositories = memoryRepositories();
  await publishCorpus(repositories);
  const app = makeApplication({ repositories, bridge: fakeBridge(), canonical: fakeCanonicalProfilePort() });
  await rejects(
    startCalibrationUi({ application: app, host: "0.0.0.0", port: 0 }),
    /allow-network/,
  );
  const ui = await startCalibrationUi({ application: app, host: "127.0.0.1", port: 0 });
  t.after(async () => ui.close());

  const bootstrapResponse = await fetch(`${ui.url}/api/v1/bootstrap`);
  strictEqual(bootstrapResponse.status, 200);
  const bootstrap = await bootstrapResponse.json();
  match(bootstrap.sessionNonce, /^[a-f0-9-]{36}$/);

  const draftResponse = await fetch(`${ui.url}/api/v1/corpus/draft`);
  strictEqual(draftResponse.status, 200);
  const etag = draftResponse.headers.get("etag");
  strictEqual(typeof etag, "string");
  const corpusResponse = await fetch(`${ui.url}/api/v1/corpus`);
  strictEqual(corpusResponse.status, 200);
  strictEqual(corpusResponse.headers.get("etag"), etag);

  const missingNonce = await fetch(`${ui.url}/api/v1/corpus/draft`, {
    method: "PUT",
    headers: { "content-type": "application/json", "if-match": etag },
    body: JSON.stringify({ workspaceId: "local-default", revision: 0, items: [] }),
  });
  strictEqual(missingNonce.status, 409);

  const staleEtag = await fetch(`${ui.url}/api/v1/corpus/draft`, {
    method: "PUT",
    headers: { "content-type": "application/json", "if-match": 'W/"corpus-draft-999"', "x-calibration-nonce": bootstrap.sessionNonce },
    body: JSON.stringify({ workspaceId: "local-default", revision: 0, items: [] }),
  });
  strictEqual(staleEtag.status, 412);

  const crossOrigin = await fetch(`${ui.url}/api/v1/bootstrap`, { headers: { origin: "https://evil.example" } });
  strictEqual(crossOrigin.status, 403);
  strictEqual((await fetch(`${ui.url}/unknown.js`)).status, 404);
  strictEqual((await fetch(`${ui.url}/../package.json`)).status, 404);
});

test("the HTTP API returns only the requested voice reference and name", async (t) => {
  const repositories = memoryRepositories();
  await publishCorpus(repositories);
  const calls = [];
  const app = makeApplication({
    repositories,
    bridge: fakeBridge(),
    canonical: fakeCanonicalProfilePort(),
    voiceDirectory: {
      async getName(voiceRef) {
        calls.push(voiceRef);
        return "Voix française";
      },
    },
  });
  const ui = await startCalibrationUi({ application: app, host: "127.0.0.1", port: 0 });
  t.after(async () => ui.close());

  // Audit VC-MAJOR1: the voice lookup triggers a billable ElevenLabs call,
  // so it now requires the session nonce like every mutation route.
  const bootstrap = await (await fetch(`${ui.url}/api/v1/bootstrap`)).json();
  const nonce = bootstrap.sessionNonce;

  const missingNonce = await fetch(`${ui.url}/api/v1/voices/voice-1`);
  strictEqual(missingNonce.status, 409);

  const response = await fetch(`${ui.url}/api/v1/voices/voice-1`, {
    headers: { "x-calibration-nonce": nonce },
  });
  strictEqual(response.status, 200);
  deepStrictEqual(await response.json(), { voiceRef: "voice-1", name: "Voix française" });
  deepStrictEqual(calls, ["voice-1"]);
});
