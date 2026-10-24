import { test } from "node:test";
import assert from "node:assert/strict";
import { createCalibrationApplication } from "../dist/calibration/application.js";
import { bootstrapRequest, bootstrapSecret, bootstrapStage } from "../dist/calibration/bootstrap-diagnostics.js";
import { HttpError, startCalibrationUi } from "../dist/calibration/http-server.js";
import { redactSensitive } from "../dist/calibration/redaction.js";
import { createSupabaseWorkspaceResolver } from "../dist/calibration/supabase-auth.js";
import { createVoiceCalibrationApplication } from "../dist/calibration/entrypoint.js";
import { BridgeTransportError } from "../dist/calibration/bridge.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function logs(t) {
  const lines = [];
  const original = console.error;
  console.error = (line) => lines.push(line);
  t.after(() => { console.error = original; });
  return lines;
}

function application(secret, observation) {
  return createCalibrationApplication({
    credentials: { status: async () => ({ configured: true }), redact: (value) => redactSensitive(value, [secret]) },
    repositories: {
      corpus: { getActiveVersion: async () => null },
      profiles: { list: async () => [] },
      runs: { list: async () => [], recoverRunning: async () => { throw new Error("Unexpected run recovery"); } },
    },
    bridge: { close: async () => {}, getSchema: async () => { throw new Error("Unexpected MCP execution"); } },
    canonical: { getObservationSummary: observation },
  });
}

test("engine readiness failures expose safe actionable codes without retrying or leaking diagnostics", async (t) => {
  const lines = logs(t);
  for (const code of ["ENGINE_STARTUP_TIMEOUT", "ENGINE_STARTUP_FAILED", "MCP_INITIALIZE_TIMEOUT", "MCP_READINESS_TIMEOUT"]) {
    let starts = 0;
    const api = await startCalibrationUi({
      resolveApplication: async () => {
        starts++;
        throw new BridgeTransportError("private container path", false, "private-provider-key", code);
      },
      closeApplications: async () => {},
    });
    try {
      const response = await fetch(`${api.url}/api/v1/bootstrap`);
      assert.equal(response.status, 503);
      const body = await response.json();
      assert.equal(body.error.code, code);
      assert.match(body.error.message, /moteur/);
      assert.match(body.error.message, /Réessayez/);
      assert(!JSON.stringify(body).includes("private"));
      assert.equal(starts, 1);
      assert.equal(JSON.parse(lines.at(-1)).correlationId, response.headers.get("x-correlation-id"));
    } finally {
      await api.close();
    }
  }
});

test("bootstrap failure logs its exact stage with correlation and redacts before truncating", async (t) => {
  const lines = logs(t);
  const secret = "provider-" + "Q".repeat(5000);
  const token = "session-bare-secret";
  const error = Object.assign(new Error(`simulated failure ${secret} ${token}`), {
    code: "E_BOOTSTRAP_TEST", stderr: `diagnostic ${secret} ${token}`,
    cause: new Error(`nested ${secret} ${token}`),
  });
  const app = application(secret, async () => { throw error; });
  const api = await startCalibrationUi({ application: app });
  t.after(() => api.close());
  const response = await fetch(`${api.url}/api/v1/bootstrap`, {
    headers: { authorization: `Bearer ${token}`, "x-correlation-id": "untrusted-client-id" },
  });
  assert.equal(response.status, 500);
  const body = await response.text();
  assert.match(body, /unexpected local failure/);
  assert.equal(lines.length, 1);
  const diagnostic = JSON.parse(lines[0]);
  assert.equal(diagnostic.stage, "observations");
  assert.equal(diagnostic.error.code, "E_BOOTSTRAP_TEST");
  assert.equal(diagnostic.correlationId, response.headers.get("x-correlation-id"));
  assert.match(diagnostic.correlationId, /^[a-f0-9-]{36}$/);
  assert.notEqual(diagnostic.correlationId, "untrusted-client-id");
  assert(diagnostic.durationMs >= 0 && diagnostic.requestDurationMs >= diagnostic.durationMs);
  for (const output of [lines[0], body]) {
    assert(!output.includes(token));
    assert(!output.includes("Q".repeat(20)));
  }
});

test("concurrent requests retain separate correlation and credential redaction", async (t) => {
  const lines = logs(t);
  const apps = ["provider-a", "provider-b"].map((secret, index) => application(secret, async () => {
    await new Promise((resolve) => setTimeout(resolve, index ? 5 : 20));
    throw new Error(`failed ${secret} session-${index}`);
  }));
  const api = await startCalibrationUi({
    resolveApplication: async (request) => {
      const index = request.headers.authorization === "Bearer session-0" ? 0 : 1;
      apps[index].authorizeSourceRead = async () => {};
      return { application: apps[index], workspaceId: "local-default", identity: { userId: `user-${index}`, tenantId: `tenant-${index}` } };
    },
    closeApplications: async () => { await Promise.all(apps.map((app) => app.close())); },
  });
  t.after(() => api.close());
  const responses = await Promise.all([0, 1].map((index) => fetch(`${api.url}/api/v1/bootstrap`, {
    headers: { authorization: `Bearer session-${index}` },
  })));
  assert.equal(lines.length, 2);
  const ids = responses.map((response) => response.headers.get("x-correlation-id"));
  assert.notEqual(ids[0], ids[1]);
  assert.deepEqual(new Set(lines.map((line) => JSON.parse(line).correlationId)), new Set(ids));
  assert(!lines.join("").match(/provider-[ab]|session-[01]/));
});

test("upstream authentication preserves network cause in private diagnostic only", async (t) => {
  const lines = logs(t);
  const resolver = createSupabaseWorkspaceResolver({
    url: "https://example.supabase.co", publishableKey: "sb_publishable_test_key",
    fetch: async () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("DNS lookup failed"), { code: "ENOTFOUND" }) }); },
  }, []);
  const api = await startCalibrationUi({ resolveApplication: resolver, closeApplications: async () => {} });
  t.after(() => api.close());
  const response = await fetch(`${api.url}/api/v1/bootstrap`, { headers: { authorization: "Bearer test-session" } });
  assert.equal(response.status, 503);
  const diagnostic = JSON.parse(lines[0]);
  assert.equal(diagnostic.stage, "authentication");
  assert.equal(diagnostic.error.cause.code, "ENOTFOUND");
  assert(!lines[0].includes("test-session"));
  assert(!lines[0].includes("sb_publishable_test_key"));
  assert(!(await response.text()).includes("DNS lookup failed"));
  const denied = await fetch(`${api.url}/api/v1/bootstrap`);
  assert.equal(denied.status, 401);
  assert.equal(lines.length, 1); // Health checks do not flood the error log.
});

test("nested stage logs once, preserves failure, and never retries when diagnostic sink fails", async (t) => {
  const original = console.error;
  console.error = () => { throw new Error("sink unavailable"); };
  t.after(() => { console.error = original; });
  const failure = new Error("MCP initialize timed out");
  let calls = 0;
  await assert.rejects(bootstrapRequest("Bearer session", () => bootstrapStage("engine_start", () =>
    bootstrapStage("mcp_handshake", () => { bootstrapSecret("provider-key"); calls++; throw failure; }))),
  (error) => error === failure);
  assert.equal(calls, 1);
});

test("cold engine corpus failure retains the original filesystem error before public normalization", async (t) => {
  const lines = logs(t);
  const root = mkdtempSync(join(tmpdir(), "bootstrap-diagnostic-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let calls = 0;
  const api = await startCalibrationUi({
    resolveApplication: async () => ({ workspaceId: "workspace-test", application: await createVoiceCalibrationApplication({
      workspaceId: "workspace-test", tenantId: "tenant-test", dataDir: join(root, "ui"), stateDir: join(root, "state"),
      wpmPath: join(root, "missing.json"), credentials: { env: { ELEVENLABS_API_KEY: "private-provider-key" } },
      mcpTransport: { schema: async () => { calls++; }, close: async () => {} },
    }) }),
    closeApplications: async () => {},
  });
  t.after(() => api.close());
  const response = await fetch(`${api.url}/api/v1/bootstrap`);
  assert.equal(response.status, 500);
  const diagnostic = JSON.parse(lines[0]);
  assert.equal(lines.length, 1);
  assert.equal(diagnostic.stage, "corpus_read");
  assert.equal(diagnostic.error.code, "ENOENT");
  assert.equal(calls, 0);
  assert(!lines[0].includes("private-provider-key"));
  assert(!(await response.text()).includes("missing.json"));
});

test("late parallel failures cannot log secrets after the request redactors are released", async (t) => {
  const lines = logs(t);
  let rejectLater;
  let pending;
  await assert.rejects(bootstrapRequest("Bearer private-session", async () => {
    bootstrapSecret("private-provider");
    pending = bootstrapStage("observations", () => new Promise((_, reject) => { rejectLater = reject; }));
    throw new HttpError(401, "unauthenticated", "expected denial");
  }));
  const failure = new Error("private-provider private-session");
  const checked = assert.rejects(pending, (error) => error === failure);
  rejectLater(failure);
  await checked;
  assert.equal(lines.length, 0);
});
