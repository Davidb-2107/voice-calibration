import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import {
  BridgeTransportError,
  NodeMcpStdioTransport,
  createCalibrationBridge,
  createCanonicalProfilePort,
} from "../dist/calibration/bridge.js";
import { createCredentialProvider, createVoiceDirectoryProvider, parseDotEnv } from "../dist/calibration/credentials.js";

const resolvedRequest = {
  contractDigest: "contract-sha",
  coreDigest: "core-sha",
  corpusVersionId: "standard-v1",
  corpusDigest: "corpus-sha",
  voiceRef: "voice-1",
  params: {
    model_id: "eleven_v3",
    voice_settings: { stability: 0.3, similarity_boost: 0.85, style: 0.3, use_speaker_boost: true },
    text_source: { kind: "inline", text: "Bonjour le monde." },
    mode: "precision",
    language: "fr",
    runs: 3,
    corpus_key: "voice-1",
  },
  postproc: "cut",
};

test("stdio child uses the construction environment and selected WPM source", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "calibration-child-"));
  const childPath = join(root, "child.mjs");
  writeFileSync(childPath, `
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2], JSON.stringify({
  key: process.env.ELEVENLABS_API_KEY ?? null,
  wpmPath: process.env.VOICE_WPM_PATH ?? null,
  marker: process.env.CALIBRATION_TEST_MARKER ?? null,
  workspace: process.env.VOICE_CALIBRATION_WORKSPACE_ID ?? null,
  state: process.env.VOICE_CALIBRATION_STATE_DIR ?? null,
  gate: process.env.VOICE_CALIBRATION_GATE_DIR ?? null,
}));
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  const result = message.method === "initialize"
    ? { protocolVersion: "2025-11-25", capabilities: {} }
    : { tools: [{ name: "calibrate_voice", inputSchema: { type: "object" } }] };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
}
`);
  const saved = {
    key: process.env.ELEVENLABS_API_KEY,
    wpm: process.env.VOICE_WPM_PATH,
    marker: process.env.CALIBRATION_TEST_MARKER,
    workspace: process.env.VOICE_CALIBRATION_WORKSPACE_ID,
    state: process.env.VOICE_CALIBRATION_STATE_DIR,
    gate: process.env.VOICE_CALIBRATION_GATE_DIR,
  };
  t.after(() => {
    for (const [name, value] of Object.entries({
      ELEVENLABS_API_KEY: saved.key,
      VOICE_WPM_PATH: saved.wpm,
      CALIBRATION_TEST_MARKER: saved.marker,
      VOICE_CALIBRATION_WORKSPACE_ID: saved.workspace,
      VOICE_CALIBRATION_STATE_DIR: saved.state,
      VOICE_CALIBRATION_GATE_DIR: saved.gate,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  process.env.ELEVENLABS_API_KEY = "old-key";
  process.env.VOICE_WPM_PATH = join(root, "inherited.json");
  process.env.CALIBRATION_TEST_MARKER = "before";
  process.env.VOICE_CALIBRATION_WORKSPACE_ID = "inherited";
  process.env.VOICE_CALIBRATION_STATE_DIR = join(root, "inherited-state");
  process.env.VOICE_CALIBRATION_GATE_DIR = join(root, "inherited-gate");
  const variants = [
    { launch: { wpmPath: join(root, "source a.json"), workspaceId: "staging", stateDir: join(root, "selected-state") }, expected: join(root, "source a.json") },
    { launch: { wpmPath: undefined }, expected: null },
    { launch: undefined, expected: join(root, "inherited.json") },
  ];
  const transports = variants.map(({ launch }, index) => new NodeMcpStdioTransport(
    process.execPath, [childPath, join(root, `child-${index}.json`)], root, launch,
  ));
  t.after(async () => {
    for (const transport of transports) await transport.close();
    rmSync(root, { recursive: true, force: true });
  });
  process.env.ELEVENLABS_API_KEY = "changed-key";
  process.env.VOICE_WPM_PATH = join(root, "changed.json");
  process.env.CALIBRATION_TEST_MARKER = "after";
  for (const [index, { expected }] of variants.entries()) {
    deepStrictEqual(await transports[index].schema("selected-key", 5000), { type: "object" });
    deepStrictEqual(JSON.parse(readFileSync(join(root, `child-${index}.json`), "utf8")), {
      key: "selected-key", wpmPath: expected, marker: "before",
      workspace: index === 0 ? "staging" : index === 1 ? null : "inherited",
      state: join(root, index === 0 ? "selected-state" : "inherited-state"),
      gate: index === 0 ? null : join(root, "inherited-gate"),
    });
  }
});

test("bridge rejects foreign workspace records in every core operation", async () => {
  const record = {
    run_id: "core-run-1", workspace_id: "workspace-b", revision: 3, status: "succeeded",
    context: {}, request: {}, request_digest: "v1:sha256:test", proposal: {}, approval: null,
    result: { status: "ok", precision_stats: { median: 148 }, publication: {
      status: "published", canonical_ref: "python://wpm", wpm: 148,
    } },
    created_at: "2026-09-02T10:00:00Z", updated_at: "2026-09-02T10:01:00Z",
  };
  const transport = {
    async schema() { return { type: "object" }; },
    async callTool() { return { response: record, emitted: true, stderr: "" }; },
    async close() {},
  };
  const bridge = createCalibrationBridge({ transport, credentials: createCredentialProvider({
    env: { ELEVENLABS_API_KEY: "test-secret" },
  }) });
  const context = { workspaceId: "workspace-a", runId: "core-run-1" };
  for (const operation of [
    () => bridge.propose({ workspaceId: context.workspaceId, request: resolvedRequest }),
    () => bridge.approve({ ...context, requestDigest: record.request_digest }),
    () => bridge.getRun(context),
    () => bridge.execute({ ...context, coreRunId: context.runId, idempotencyKey: context.runId, snapshot: resolvedRequest }),
    () => bridge.reconcile({ ...context, coreRunId: context.runId, idempotencyKey: context.runId }),
    () => bridge.publish(context),
  ]) await rejects(operation(), /calibration core workspace mismatch/);
});

test("bridge rejects invalid workspace before credentials or transport", async () => {
  let calls = 0;
  const touch = async () => { calls += 1; throw new Error("unexpected IO"); };
  const bridge = createCalibrationBridge({
    transport: { schema: touch, call: touch, callTool: touch, async close() {} },
    credentials: { forRun: touch },
  });
  const context = { workspaceId: "WORKSPACE-A", runId: "core-run-1" };
  for (const operation of [
    () => bridge.propose({ workspaceId: context.workspaceId, request: resolvedRequest }),
    () => bridge.approve({ ...context, requestDigest: "digest" }),
    () => bridge.getRun(context),
    () => bridge.execute({ ...context, coreRunId: context.runId, idempotencyKey: context.runId, snapshot: resolvedRequest }),
    () => bridge.reconcile({ ...context, coreRunId: context.runId, idempotencyKey: context.runId }),
    () => bridge.publish(context),
  ]) await rejects(operation(), /invalid workspaceId/);
  strictEqual(calls, 0);
});

test("bridge rejects supplied invalid workspace with or without a core run", async (t) => {
  for (const workspaceId of ["", null, false, 0, "WORKSPACE-A", "../workspace-a", {}]) {
    for (const coreRunId of ["core-run-1", undefined]) {
      for (const method of ["execute", "reconcile"]) {
        await t.test(`${method}: ${JSON.stringify(workspaceId)}, coreRunId=${coreRunId}`, async () => {
          let calls = 0;
          const touch = async () => { calls += 1; throw new Error("unexpected IO"); };
          const bridge = createCalibrationBridge({
            transport: { schema: touch, call: touch, callTool: touch, async close() {} },
            credentials: { forRun: touch },
          });
          await rejects(bridge[method]({ workspaceId, coreRunId, runId: "r", idempotencyKey: "r", snapshot: resolvedRequest }), /invalid workspaceId/);
          strictEqual(calls, 0);
        });
      }
    }
  }
});

function fakeTransport(options = {}) {
  const schema = { type: "object", additionalProperties: false };
  const transport = {
    schemaValue: schema,
    calls: [],
    async schema(secret) { this.schemaCredentialWasPassed = Boolean(secret); return this.schemaValue; },
    async call(args, secret) {
      this.calls.push({ args, credentialWasPassed: Boolean(secret) });
      if (options.preSendFailure) {
        throw new BridgeTransportError(`pre-send failure ${secret}`, false, `diagnostic ${secret}`);
      }
      if (options.dropExecutionResponse && args.dry_run === false) {
        throw new BridgeTransportError("response lost", true, `diagnostic ${secret}`);
      }
      if (options.remoteError && args.dry_run === false) {
        return { response: undefined, emitted: true, stderr: `stderr ${secret}`, remoteError: { code: -32602, message: `invalid request ${secret}` } };
      }
      if (args.dry_run) return { response: options.dryRun ?? { status: "dry_run_success", requests_planned: 3 }, emitted: true, stderr: `stderr ${secret}` };
      return { response: options.execute ?? { status: "ok", precision_stats: { median: 148 } }, emitted: true, stderr: `stderr ${secret}` };
    },
    async close() {},
  };
  return transport;
}

test("bridge forwards the resolved request and keeps credentials out of arguments", async () => {
  const transport = fakeTransport();
  const bridge = createCalibrationBridge({ transport, credentials: createCredentialProvider({ env: { ELEVENLABS_API_KEY: "secret" } }) });
  deepStrictEqual(await bridge.getSchema(), transport.schemaValue);
  strictEqual(transport.schemaCredentialWasPassed, true);
  const result = await bridge.dryRun({ runId: "r1", request: resolvedRequest });
  strictEqual(result.accepted, true);
  strictEqual(transport.calls.length, 1);
  strictEqual(transport.calls[0].args.voice, "voice-1");
  strictEqual(transport.calls[0].args.dry_run, true);
  strictEqual(transport.calls[0].args.postproc, "cut");
  strictEqual(JSON.stringify(transport.calls).includes("secret"), false);
});

test("bridge proposes through the core gate with the complete snapshot context", async () => {
  const calls = [];
  const transport = {
    schemaValue: { type: "object", additionalProperties: false },
    async schema() { return this.schemaValue; },
    async callTool(name, args, secret) {
      calls.push({ name, args, credentialWasPassed: Boolean(secret) });
      return {
        response: {
          run_id: "core-run-1",
          workspace_id: "local-default",
          revision: 0,
          status: "dry_run_ready",
          context: {
            corpus_version_id: "standard-v1",
            corpus_digest: "corpus-sha",
            contract_digest: "contract-sha",
            core_digest: "core-sha",
          },
          request: { ...resolvedRequest.params, voice: resolvedRequest.voiceRef, postproc: resolvedRequest.postproc, dry_run: false },
          request_digest: "v1:sha256:core-digest",
          proposal: { status: "dry_run_success", requests_planned: 3, diagnostic: secret },
          approval: null,
          result: null,
          created_at: "2026-09-03T10:00:00Z",
          updated_at: "2026-09-03T10:00:00Z",
        },
        emitted: true,
        stderr: `diagnostic ${secret}`,
      };
    },
    async close() {},
  };
  const bridge = createCalibrationBridge({
    transport,
    credentials: createCredentialProvider({ env: { ELEVENLABS_API_KEY: "secret" } }),
  });

  const result = await bridge.propose({ workspaceId: "local-default", request: resolvedRequest });

  strictEqual(result.accepted, true);
  strictEqual(result.runId, "core-run-1");
  strictEqual(result.requestDigest, "v1:sha256:core-digest");
  strictEqual(result.raw.proposal.diagnostic, "[REDACTED]");
  strictEqual(JSON.stringify(result).includes("secret"), false);
  strictEqual(calls[0].name, "propose_calibration");
  strictEqual(calls[0].args.workspace_id, "local-default");
  strictEqual(calls[0].args.voice_id, resolvedRequest.voiceRef);
  strictEqual(Object.hasOwn(calls[0].args, "dry_run"), false);
  strictEqual(calls[0].args.corpus_version_id, "standard-v1");
  strictEqual(calls[0].args.corpus_digest, "corpus-sha");
  deepStrictEqual(calls[0].args.text_source, resolvedRequest.params.text_source);
  strictEqual(JSON.stringify(calls).includes("secret"), false);
});

test("bridge routes core approval and execution without resending the provider snapshot", async () => {
  const calls = [];
  const base = {
    run_id: "core-run-1",
    workspace_id: "local-default",
    revision: 1,
    status: "approved",
    context: { corpus_version_id: "standard-v1", corpus_digest: "corpus-sha", contract_digest: "contract-sha", core_digest: "core-sha" },
    request: { ...resolvedRequest.params, voice: resolvedRequest.voiceRef, postproc: resolvedRequest.postproc, dry_run: false },
    request_digest: "v1:sha256:core-digest",
    proposal: { status: "dry_run_success", requests_planned: 3 },
    approval: { approved_at: "2026-09-03T10:00:00Z", expires_at: "2026-09-03T10:15:00Z", consumed_at: null },
    result: null,
    created_at: "2026-09-03T10:00:00Z",
    updated_at: "2026-09-03T10:00:00Z",
  };
  const transport = {
    async schema() { return { type: "object" }; },
    async callTool(name, args, secret) {
      calls.push({ name, args, credentialWasPassed: Boolean(secret) });
      if (name === "approve_calibration") return { response: base, emitted: true, stderr: "" };
      if (name === "get_calibration_run" || name === "reconcile_calibration")
        return { response: base, emitted: true, stderr: "" };
      return {
        response: {
          ...base,
          status: "succeeded",
          revision: 2,
          approval: { ...base.approval, consumed_at: "2026-09-03T10:00:01Z" },
          result: { status: "ok", precision_stats: { median: 168, n: 3 } },
        },
        emitted: true,
        stderr: "",
      };
    },
    async close() {},
  };
  const bridge = createCalibrationBridge({
    transport,
    credentials: createCredentialProvider({ env: { ELEVENLABS_API_KEY: "secret" } }),
  });

  const approved = await bridge.approve({ workspaceId: "local-default", runId: "core-run-1", requestDigest: base.request_digest });
  strictEqual(approved.status, "approved");
  strictEqual(approved.approval.consumedAt, null);
  const executed = await bridge.execute({
    runId: "core-run-1",
    idempotencyKey: "core-run-1",
    snapshot: resolvedRequest,
    workspaceId: "local-default",
    coreRunId: "core-run-1",
  });
  strictEqual(executed.status, "succeeded");
  strictEqual(executed.coreRun.status, "succeeded");
  deepStrictEqual(executed.metrics, { precision_stats: { median: 168, n: 3 } });
  strictEqual(calls[0].name, "approve_calibration");
  strictEqual(calls[1].name, "execute_calibration");
  strictEqual(calls[1].args.run_id, "core-run-1");
  strictEqual(Object.hasOwn(calls[1].args, "text_source"), false);
});

test("bridge routes explicit publication through the core gate", async () => {
  const calls = [];
  const transport = {
    async schema() { return { type: "object" }; },
    async callTool(name, args, secret) {
      calls.push({ name, args, credentialWasPassed: Boolean(secret) });
      return {
        response: {
          run_id: "core-run-1",
          workspace_id: "local-default",
          revision: 3,
          status: "succeeded",
          context: {},
          request: {},
          request_digest: "v1:sha256:core-digest",
          proposal: {},
          approval: null,
          result: {
            status: "ok",
            publication: {
              status: "published",
              canonical_ref: "Shared/voice-calibration/voice_wpm.json#voice-1.wpm_calibrated",
              wpm: 179,
              runs_published: 3,
            },
          },
          created_at: "2026-09-03T10:00:00Z",
          updated_at: "2026-09-03T10:01:00Z",
        },
        emitted: true,
        stderr: "",
      };
    },
    async close() {},
  };
  const bridge = createCalibrationBridge({
    transport,
    credentials: createCredentialProvider({ env: { ELEVENLABS_API_KEY: "secret" } }),
  });

  deepStrictEqual(
    await bridge.publish({ workspaceId: "local-default", runId: "core-run-1" }),
    {
      canonicalRef: "Shared/voice-calibration/voice_wpm.json#voice-1.wpm_calibrated",
      wpm: 179,
      runsPublished: 3,
    },
  );
  strictEqual(calls.length, 1);
  strictEqual(calls[0].name, "publish_calibration");
  strictEqual(calls[0].args.workspace_id, "local-default");
  strictEqual(calls[0].args.run_id, "core-run-1");
  strictEqual(JSON.stringify(calls).includes("secret"), false);
});

test("lost execution response becomes execution_unknown without replay", async () => {
  const transport = fakeTransport({ dropExecutionResponse: true });
  const bridge = createCalibrationBridge({ transport, credentials: createCredentialProvider({ env: { ELEVENLABS_API_KEY: "secret" } }), timeoutMs: 20 });
  await rejects(
    bridge.execute({ runId: "r1", idempotencyKey: "r1", snapshot: resolvedRequest }),
    /execution_unknown/,
  );
  strictEqual(transport.calls.length, 1);
  deepStrictEqual(await bridge.reconcile({ runId: "r1", idempotencyKey: "r1" }), { status: "unknown" });
  strictEqual(transport.calls.length, 1);
});

test("pre-send failure is not execution_unknown and does not expose diagnostics", async () => {
  const transport = fakeTransport({ preSendFailure: true });
  const bridge = createCalibrationBridge({ transport, credentials: createCredentialProvider({ env: { ELEVENLABS_API_KEY: "secret" } }) });
  await rejects(
    bridge.execute({ runId: "r1", idempotencyKey: "r1", snapshot: resolvedRequest }),
    (error) => error.message.includes("secret") === false && error.message.includes("pre-send failure") === true,
  );
});

test("a received MCP error is failed, not execution_unknown, and is redacted", async () => {
  const transport = fakeTransport({ remoteError: true });
  const bridge = createCalibrationBridge({ transport, credentials: createCredentialProvider({ env: { ELEVENLABS_API_KEY: "secret" } }) });
  const result = await bridge.execute({ runId: "r1", idempotencyKey: "r1", snapshot: resolvedRequest });
  strictEqual(result.status, "failed");
  strictEqual(result.error.code, "-32602");
  strictEqual(result.error.message.includes("secret"), false);
  strictEqual(JSON.stringify(result.raw).includes("secret"), false);
});

test("successful source metrics and result envelope are preserved without recalculation", async () => {
  const transport = fakeTransport({ execute: {
    status: "ok",
    precision_stats: { n: 3, median: 148, min: 146, max: 150 },
    billable_characters: 1234,
    actual_credits_used: 617,
    actual_cost_usd: 0.0617,
  } });
  const bridge = createCalibrationBridge({ transport, credentials: createCredentialProvider({ env: { ELEVENLABS_API_KEY: "secret" } }) });
  const result = await bridge.execute({ runId: "r1", idempotencyKey: "r1", snapshot: resolvedRequest });
  strictEqual(result.status, "succeeded");
  deepStrictEqual(result.metrics, {
    precision_stats: { n: 3, median: 148, min: 146, max: 150 },
    billable_characters: 1234,
    actual_credits_used: 617,
    actual_cost_usd: 0.0617,
  });
  strictEqual(JSON.stringify(result.raw).includes("secret"), false);
});

test("credential status never returns the key and the parser preserves quoted values", async () => {
  const provider = createCredentialProvider({ env: { ELEVENLABS_API_KEY: "secret" } });
  deepStrictEqual(await provider.status(), { configured: true });
  strictEqual(JSON.stringify(await provider.status()).includes("secret"), false);
  deepStrictEqual(parseDotEnv("# comment\nELEVENLABS_API_KEY=\"quoted-value\"\nOTHER=x=y"), { ELEVENLABS_API_KEY: "quoted-value", OTHER: "x=y" });
  deepStrictEqual(await createCredentialProvider({ env: {} }).status(), { configured: false });
});

test("credential provider honors an explicit env file without exposing it", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "calibration-env-"));
  const envFile = join(dataDir, ".env");
  writeFileSync(envFile, "ELEVENLABS_API_KEY='from-file'\n");
  const provider = createCredentialProvider({ cwd: dataDir, envFile: ".env" });
  deepStrictEqual(await provider.status(), { configured: true });
  strictEqual((await provider.forRun()).secret, "from-file");

  const explicitFileWins = createCredentialProvider({ env: { ELEVENLABS_API_KEY: "from-process" }, cwd: dataDir, envFile: ".env" });
  strictEqual((await explicitFileWins.forRun()).secret, "from-file");
});

test("credential provider discovers the central Projects env from a Shared project", (t) => {
  const root = mkdtempSync(join(tmpdir(), "calibration-shared-vault-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sharedProject = join(root, "Shared", "calibration-ui-mvp");
  mkdirSync(sharedProject, { recursive: true });
  mkdirSync(join(root, "Projects"), { recursive: true });
  writeFileSync(join(root, "Projects", ".env"), "ELEVENLABS_API_KEY=from-projects\n");

  const provider = createCredentialProvider({ cwd: sharedProject });
  return provider.status().then((status) => deepStrictEqual(status, { configured: true }));
});

test("credential provider discovers the vault Projects env when the app is outside the vault", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "calibration-external-vault-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const vault = join(root, "Wiki_Claude");
  const externalProject = join(root, "src", "voice-calibration");
  mkdirSync(join(vault, "Projects"), { recursive: true });
  mkdirSync(join(vault, "Shared"), { recursive: true });
  mkdirSync(externalProject, { recursive: true });
  writeFileSync(join(vault, "Projects", ".env"), "ELEVENLABS_API_KEY=from-vault\n");

  const provider = createCredentialProvider({ cwd: externalProject, vaultRoot: vault });
  deepStrictEqual(await provider.status(), { configured: true });
  strictEqual((await provider.forRun()).secret, "from-vault");
});

test("voice directory resolves a voice name with the server-side ElevenLabs credential", async () => {
  const calls = [];
  const credentials = createCredentialProvider({ env: { ELEVENLABS_API_KEY: "secret" } });
  const directory = createVoiceDirectoryProvider({
    credentials,
    fetcher: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        async json() { return { voice_id: "voice-1", name: "Voix française" }; },
      };
    },
  });

  strictEqual(await directory.getName("voice-1"), "Voix française");
  strictEqual(calls[0].url, "https://api.elevenlabs.io/v1/voices/voice-1");
  strictEqual(calls[0].init.headers["xi-api-key"], "secret");
});

test("profile publication verifies the canonical Python WPM source", async () => {
  const canonical = createCanonicalProfilePort({
    verify: async () => ({ canonicalRef: "Shared/voice-calibration/voice_wpm.json#voice-1.wpm_calibrated", wpm: 148 }),
  });
  deepStrictEqual(
    await canonical.ensurePublished({ voiceRef: "voice-1", wpm: 148, runId: "r1", corpusVersionId: "standard-v1" }),
    { canonicalRef: "Shared/voice-calibration/voice_wpm.json#voice-1.wpm_calibrated" },
  );
});

test("canonical profile port detects an existing published voice before calibration", async () => {
  const root = mkdtempSync(join(tmpdir(), "canonical-profile-"));
  try {
    const wpmPath = join(root, "voice_wpm.json");
    writeFileSync(
      wpmPath,
      JSON.stringify({
        "voice-1": {
          profile: { voice_id: "voice-1", model_id: "eleven_multilingual_v2", voice_settings: {} },
          wpm_calibrated: 172.5,
        },
      }),
    );
    const canonical = createCanonicalProfilePort({ wpmPath, language: "fr" });
    deepStrictEqual(
      await canonical.findPublished?.({ voiceRef: "voice-1", language: "fr" }),
      {
        canonicalRef: `${pathToFileURL(wpmPath).href}#voice-1.wpm_calibrated`,
        wpm: 172.5,
      },
    );
    const historical = createCanonicalProfilePort({
      wpmPath, referenceBase: "Shared/voice-calibration/voice_wpm.json",
    });
    deepStrictEqual(await historical.findPublished({ voiceRef: "voice-1" }), {
      canonicalRef: "Shared/voice-calibration/voice_wpm.json#voice-1.wpm_calibrated", wpm: 172.5,
    });
    strictEqual(await canonical.findPublished?.({ voiceRef: "voice-2", language: "fr" }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("canonical ports keep separate sources, reread content, and encode FR/EN references", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "canonical-sources-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pathA = join(root, "source a.json");
  const pathB = join(root, "source b.json");
  writeFileSync(pathA, "{}");
  writeFileSync(pathB, JSON.stringify({
    "voix été": {
      profile: { voice_id: "fr" }, wpm_calibrated: 148,
      profiles_by_lang: { en: { voice_id: "en" } }, wpm_calibrated_by_lang: { en: 154 },
    },
  }));
  const a = createCanonicalProfilePort({ wpmPath: pathA });
  const b = createCanonicalProfilePort({ wpmPath: pathB });
  const input = { voiceRef: "voix été", wpm: 148, runId: "r", corpusVersionId: "v" };
  strictEqual(await a.findPublished({ voiceRef: input.voiceRef }), null);
  await rejects(a.ensurePublished(input), /canonical_wpm_unavailable/);
  const fragment = encodeURIComponent("voix été.wpm_calibrated");
  deepStrictEqual(await b.findPublished({ voiceRef: input.voiceRef }), {
    canonicalRef: `${pathToFileURL(pathB).href}#${fragment}`, wpm: 148,
  });
  deepStrictEqual(await b.findPublished({ voiceRef: input.voiceRef, language: "en" }), {
    canonicalRef: `${pathToFileURL(pathB).href}#${encodeURIComponent("voix été.wpm_calibrated_by_lang.en")}`, wpm: 154,
  });
  writeFileSync(pathA, JSON.stringify({ "fresh voice": { observed_runs: [] } }));
  deepStrictEqual((await a.getObservationSummary()).voices.map((voice) => voice.voiceRef), ["fresh voice"]);
  strictEqual(await a.findPublished({ voiceRef: input.voiceRef }), null);
  const savedPath = process.env.VOICE_WPM_PATH;
  process.env.VOICE_WPM_PATH = pathB;
  t.after(() => savedPath === undefined ? delete process.env.VOICE_WPM_PATH : process.env.VOICE_WPM_PATH = savedPath);
  strictEqual(await a.findPublished({ voiceRef: input.voiceRef }), null);
  const noSource = createCanonicalProfilePort({ wpmPath: undefined });
  deepStrictEqual(await noSource.getObservationSummary(), { sourceAvailable: false, voices: [] });
  await rejects(noSource.ensurePublished(input), /canonical_wpm_unavailable/);
});

test("canonical observation summary follows raw-clean and post-processing protocol without editing history", async () => {
  const root = mkdtempSync(join(tmpdir(), "canonical-observations-"));
  try {
    const wpmPath = join(root, "voice_wpm.json");
    const source = {
      _default: 200,
      Voice: {
        observed_runs: [
          { words: 100, duration_s: 30, duration_raw_s: 60, postproc: "cut", verified: true },
          { words: 100, duration_s: 40, duration_raw_s: 50, postproc: "trim", verified: false },
          { words: 100, duration_s: 60, postproc: "raw", verified: true },
          { words: 100, duration_s: 60, postproc: "raw", verified: true, language: "en" },
          { words: 100, duration_s: 30, duration_raw_s: 60, postproc: "cut", verified: true, outlier_excluded: true },
          { words: 100, duration_s: 30, verified: true },
          { words: 100, duration_s: 30, postproc: "vendor-special", verified: true },
        ],
      },
      Empty: { observed_runs: [] },
    };
    writeFileSync(wpmPath, JSON.stringify(source));
    const before = JSON.stringify(source);
    const summary = await createCanonicalProfilePort({ wpmPath }).getObservationSummary?.();
    deepStrictEqual(summary, {
      sourceAvailable: true,
      voices: [
        { voiceRef: "Voice", total: 7, raw: 2, rawClean: 3, trim: 1, cut: 2, other: 1, unknown: 1 },
        { voiceRef: "Empty", total: 0, raw: 0, rawClean: 0, trim: 0, cut: 0, other: 0, unknown: 0 },
      ],
    });
    strictEqual(JSON.stringify(JSON.parse(readFileSync(wpmPath, "utf8"))), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("profile publication fails closed on a missing or mismatched canonical record", async () => {
  const missing = createCanonicalProfilePort({ verify: async () => { throw new Error("canonical_wpm_unavailable"); } });
  await rejects(missing.ensurePublished({ voiceRef: "voice-1", wpm: 148, runId: "r1", corpusVersionId: "v1" }), /canonical_wpm_unavailable/);
  const mismatch = createCanonicalProfilePort({ verify: async () => ({ canonicalRef: "ref", wpm: 147 }) });
  await rejects(mismatch.ensurePublished({ voiceRef: "voice-1", wpm: 148, runId: "r1", corpusVersionId: "v1" }), /canonical_wpm_mismatch/);
});
