import { test } from "node:test";
import { strictEqual, deepStrictEqual, rejects, doesNotMatch } from "node:assert";
import { mkdtemp, rm, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import { once } from "node:events";
import { CalibrationJobQueue } from "../dist/calibration/job-queue.js";
import { startCalibrationUi } from "../dist/calibration/http-server.js";
import { createLocalStore } from "../dist/calibration/ports.js";
import { fakeBridge, fakeCanonicalProfilePort, makeApplication } from "./calibration-api.test.mjs";
import { startSupabaseCalibrationApi } from "../dist/calibration/supabase-auth.js";

const identity = (i) => ({ userId: `user-${i}`, tenantId: `tenant-${i}`, workspaceId: `workspace-${i}` });
const run = (i) => ({ id: `run-${i}`, workspaceId: `workspace-${i}`, status: "approved", requestDigest: `digest-${i}`,
  configurationIdentity: `config-${i}`, approval: { consumedAt: null, expiresAt: new Date(Date.now() + 600_000).toISOString() } });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
async function until(check) {
  const deadline = Date.now() + 5_000;
  while (!(await check())) { if (Date.now() > deadline) throw new Error("Timed out"); await new Promise((r) => setTimeout(r, 5)); }
}
async function fixture(t, limit = 4) {
  const root = await mkdtemp(join(tmpdir(), "calibration-queue-"));
  const queue = await CalibrationJobQueue.open(root, limit);
  t.after(async () => { await queue.close(); await rm(root, { recursive: true, force: true }); });
  return { root, queue };
}

test("100 independent workspaces obey the execution limit, FIFO, and duplicate admission", async (t) => {
  const { root, queue } = await fixture(t);
  let active = 0, peak = 0;
  const calls = [], releases = Array.from({ length: 100 }, deferred);
  const authorize = (i) => async () => ({
    getRun: async () => run(i),
    execute: async (workspaceId, runId) => {
      strictEqual(workspaceId, identity(i).workspaceId); strictEqual(runId, run(i).id);
      calls.push(i); active++; peak = Math.max(peak, active);
      await releases[i].promise; active--;
      return { ...run(i), status: "succeeded" };
    },
  });
  await Promise.all(Array.from({ length: 100 }, (_, i) => queue.enqueue(identity(i), run(i), authorize(i))));
  await until(() => calls.length === 4);
  deepStrictEqual(calls, [0, 1, 2, 3]);
  await Promise.all(Array.from({ length: 10 }, () => queue.enqueue(identity(0), run(0), authorize(0))));
  strictEqual(calls.length, 4);
  strictEqual((await queue.get(identity(99), run(0).id)), null);
  strictEqual((await queue.get({ ...identity(0), userId: "foreign" }, run(0).id)), null);
  for (const release of releases) release.resolve();
  try { await until(async () => (await queue.get(identity(99), run(99).id)).status === "finished"); }
  catch (error) { throw new Error("100-workspace queue failed", { cause: queue.failure ?? error }); }
  strictEqual(peak, 4); strictEqual(calls.length, 100);
  const jobs = (await readdir(root)).filter((n) => n.endsWith(".json"));
  strictEqual(jobs.length, 100);
  for (const name of jobs) doesNotMatch(await readFile(join(root, name), "utf8"), /Bearer|ELEVENLABS_API_KEY|authorization/);
});

test("fresh authorization, changed identity and unknown outcomes do not block the next job", async (t) => {
  const { queue } = await fixture(t, 1);
  const hold = deferred(); let paid = 0, revoked = false;
  await queue.enqueue(identity(0), run(0), async () => ({ getRun: async () => run(0), execute: async () => {
    await hold.promise; return { ...run(0), status: "succeeded" };
  } }));
  await queue.enqueue(identity(1), run(1), async () => {
    if (revoked) throw new Error("membership revoked");
    return { getRun: async () => run(1), execute: async () => { paid++; } };
  });
  await queue.enqueue(identity(2), run(2), async () => ({ getRun: async () => ({ ...run(2), configurationIdentity: "changed" }),
    execute: async () => { paid++; } }));
  await queue.enqueue(identity(3), run(3), async () => ({ getRun: async () => run(3), execute: async () => {
    paid++; throw new Error("transport interrupted after sending");
  } }));
  await queue.enqueue(identity(4), run(4), async () => ({ getRun: async () => run(4),
    execute: async () => { paid++; return { ...run(4), status: "succeeded" }; } }));
  revoked = true; hold.resolve();
  await until(async () => (await queue.get(identity(4), run(4).id)).status === "finished");
  strictEqual(paid, 2);
  strictEqual((await queue.get(identity(1), run(1).id)).status, "awaiting_authentication");
  strictEqual((await queue.get(identity(2), run(2).id)).status, "awaiting_authentication");
  strictEqual((await queue.get(identity(3), run(3).id)).status, "execution_unknown");
  await queue.enqueue(identity(3), run(3), async () => { throw new Error("must not retry"); });
  strictEqual(paid, 2);
});

test("restart retains waiting jobs without tokens and never replays an interrupted execution", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "queue-restart-"));
  const queue = await CalibrationJobQueue.open(root, 1);
  await rejects(CalibrationJobQueue.open(root), /EEXIST/);
  const hold = deferred(); let paid = 0;
  await queue.enqueue(identity(0), run(0), async () => ({ getRun: async () => run(0), execute: async () => {
    paid++; await hold.promise; return { ...run(0), status: "succeeded" };
  } }));
  await queue.enqueue(identity(1), run(1), async () => { throw new Error("must wait"); });
  await until(async () => (await queue.get(identity(0), run(0).id)).status === "running");
  const closing = queue.close(); hold.resolve(); await closing;
  strictEqual((await queue.get(identity(1), run(1).id)).status, "awaiting_authentication");
  // Persist the two crash windows, before dispatch and after its durable marker.
  for (const name of (await readdir(root)).filter((n) => n.endsWith(".json"))) {
    const path = join(root, name), job = JSON.parse(await readFile(path, "utf8"));
    job.status = job.runId === "run-0" ? "running" : "queued";
    await writeFile(path, JSON.stringify(job));
  }
  const resumed = await CalibrationJobQueue.open(root);
  t.after(async () => { await resumed.close(); await rm(root, { recursive: true, force: true }); });
  strictEqual((await resumed.get(identity(0), "run-0")).status, "execution_unknown");
  strictEqual((await resumed.get(identity(1), "run-1")).status, "awaiting_authentication");
  strictEqual(paid, 1);
  await resumed.enqueue(identity(0), run(0), async () => { paid++; throw new Error("no retry"); });
  await rejects(resumed.enqueue({ ...identity(1), userId: "foreign" }, run(1), async () => {}), /identity mismatch/);
  await resumed.enqueue(identity(1), run(1), async () => ({ getRun: async () => run(1), execute: async () => {
    paid++; return { ...run(1), status: "succeeded" };
  } }));
  await until(async () => (await resumed.get(identity(1), "run-1")).status === "finished");
  strictEqual(paid, 2);
});

test("invalid and expired approvals, malformed persisted jobs and invalid limits fail closed", async (t) => {
  const { root, queue } = await fixture(t);
  for (const bad of [0, -1, 1.5, NaN, "4", null]) await rejects(CalibrationJobQueue.open(root, bad), TypeError);
  for (const approval of [null, { consumedAt: "used", expiresAt: run(0).approval.expiresAt },
    { consumedAt: null, expiresAt: "invalid" }, { consumedAt: null, expiresAt: "2000-01-01T00:00:00Z" }])
    await rejects(queue.enqueue(identity(0), { ...run(0), approval }, async () => {}), /approval/);
  await queue.close();
  await writeFile(join(root, `${"a".repeat(64)}.json`), "{}");
  await rejects(CalibrationJobQueue.open(root), /workspaceId|Invalid/);
});

test("killed API leaves a durable marker, requires supervision and never replays the provider", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "queue-killed-"));
  const child = fork(new URL("./fixtures/job-queue-crash.mjs", import.meta.url), [root], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  let resumed;
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill();
    await resumed?.close(); await rm(root, { recursive: true, force: true }); });
  await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw new Error("Child failed before ready"); })]);
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  await rejects(CalibrationJobQueue.open(root), /EEXIST/);
  // The test supervisor has observed the only owning process exit; no real Python engine exists here.
  await rm(join(root, "owner.lock"));
  resumed = await CalibrationJobQueue.open(root);
  strictEqual((await resumed.get(identity(0), "run-0")).status, "execution_unknown");
  strictEqual((await resumed.get(identity(1), "run-1")).status, "awaiting_authentication");
  await resumed.enqueue(identity(0), run(0), async () => { throw new Error("must not dispatch again"); });
  strictEqual((await readFile(join(root, "provider-receipts.txt"), "utf8")).trim().split("\n").length, 1);
});

test("one workspace cannot occupy two execution slots", async (t) => {
  const { queue } = await fixture(t, 4);
  const hold = deferred(); const calls = [];
  const second = { ...run(0), id: "other-run", requestDigest: "other-digest" };
  await queue.enqueue(identity(0), run(0), async () => ({ getRun: async () => run(0), execute: async () => {
    calls.push("first"); await hold.promise; return { ...run(0), status: "succeeded" };
  } }));
  await queue.enqueue(identity(0), second, async () => ({ getRun: async () => second, execute: async () => {
    calls.push("second"); return { ...second, status: "succeeded" };
  } }));
  await queue.enqueue(identity(1), run(1), async () => ({ getRun: async () => run(1), execute: async () => {
    calls.push("other-workspace"); return { ...run(1), status: "succeeded" };
  } }));
  await until(() => calls.includes("other-workspace"));
  strictEqual(calls.includes("second"), false);
  hold.resolve();
  await until(async () => (await queue.get(identity(0), second.id)).status === "finished");
  strictEqual(calls.indexOf("first") < calls.indexOf("second"), true);
});

test("protected HTTP queue returns 202, rechecks authorization, and isolates job reads", async (t) => {
  const { queue } = await fixture(t, 1);
  const hold = deferred(); let paid = 0, authorized = true, authCalls = 0;
  const app = { getSessionNonce: () => "nonce", getRun: async (_ws, id) => run(Number(id.split("-")[1])),
    execute: async (_ws, id) => { paid++; await hold.promise; return { ...run(Number(id.split("-")[1])), status: "succeeded" }; } };
  const ui = await startCalibrationUi({ jobQueue: queue, closeApplications: async () => {}, resolveApplication: async (request) => {
    authCalls++;
    if (!authorized) throw new Error("auth revoked");
    const i = request.headers.authorization === "Bearer bob" ? 1 : 0;
    return { application: app, workspaceId: identity(i).workspaceId,
      identity: { userId: identity(i).userId, tenantId: identity(i).tenantId } };
  } });
  t.after(() => ui.close());
  const call = (id, token = "alice", method = "POST", action = "enqueue") => fetch(`${ui.url}/api/v1/calibration-runs/run-${id}/${action}`,
    { method, headers: { authorization: `Bearer ${token}`, "x-calibration-nonce": "nonce", "content-type": "application/json" },
      ...(method === "POST" ? { body: "{}" } : {}) });
  strictEqual((await call(0)).status, 202);
  await until(() => paid === 1);
  strictEqual((await call(0, "bob", "GET", "job")).status, 404);
  strictEqual((await call(1, "bob")).status, 202);
  const before = authCalls; authorized = false; hold.resolve();
  await until(async () => (await queue.get(identity(1), "run-1")).status === "awaiting_authentication");
  strictEqual(paid, 1); strictEqual(authCalls > before, true);
});

test("queued execution preserves the synchronous HTTP contract and application approval guards", async (t) => {
  const { root, queue } = await fixture(t, 1);
  const repositories = createLocalStore(join(root, "application"));
  const workspaceId = identity(0).workspaceId;
  const draft = await repositories.corpus.saveDraft(workspaceId, { workspaceId, revision: 0,
    items: [{ id: "one", order: 0, text: "Bonjour le monde." }] }, 0);
  await repositories.corpus.publishDraft(workspaceId, draft.revision);
  const bridge = fakeBridge();
  const app = makeApplication({ repositories, bridge, canonical: fakeCanonicalProfilePort() });
  const prepared = await app.prepareDryRun({ workspaceId, voiceRef: "voice-test", params: {
    language: "fr", mode: "precision", runs: 3 }, postproc: "cut" });
  const ui = await startCalibrationUi({ jobQueue: queue, closeApplications: async () => {},
    resolveApplication: async () => ({ application: app, workspaceId,
      identity: { userId: identity(0).userId, tenantId: identity(0).tenantId } }) });
  t.after(() => ui.close());
  const execute = () => fetch(`${ui.url}/api/v1/calibration-runs/${prepared.id}/execute`, { method: "POST",
    headers: { "x-calibration-nonce": app.getSessionNonce(), "content-type": "application/json" }, body: "{}" });
  strictEqual((await execute()).status, 409);
  strictEqual(bridge.state.executions.length, 0);
  await app.approve(workspaceId, prepared.id, { requestDigest: prepared.requestDigest });
  const response = await execute(); strictEqual(response.status, 200);
  const result = await response.json(); strictEqual(result.id, prepared.id); strictEqual(result.status, "succeeded");
  strictEqual((await app.getRun(workspaceId, prepared.id)).approval.consumedAt !== null, true);
  strictEqual((await execute()).status, 200);
  strictEqual(bridge.state.executions.length, 1);
});

test("failure to persist the outcome stops dispatch and retains supervision lock", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "queue-storage-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const queue = await CalibrationJobQueue.open(root, 1);
  const save = queue.save.bind(queue);
  queue.save = async (job) => {
    if (job.status === "finished") throw new Error("simulated disk full");
    return save(job);
  };
  let paid = 0;
  await queue.enqueue(identity(0), run(0), async () => ({ getRun: async () => run(0), execute: async () => {
    paid++; return { ...run(0), status: "succeeded" };
  } }));
  await until(() => queue.failure);
  await rejects(queue.enqueue(identity(1), run(1), async () => { paid++; }), /storage failure/);
  await rejects(queue.close(), /owner lock retained/);
  await rejects(CalibrationJobQueue.open(root), /EEXIST/);
  const name = (await readdir(root)).find((n) => n.endsWith(".json"));
  strictEqual(JSON.parse(await readFile(join(root, name), "utf8")).status, "running");
  strictEqual(paid, 1);
});

test("protected entrypoint rejects queue paths overlapping private workspace resources", async (t) => {
  const { root } = await fixture(t);
  const dataDir = join(root, "tenant", "ui"), stateDir = join(root, "tenant", "state"), corpusDir = join(root, "tenant", "corpus");
  const options = { supabase: { url: "https://test-project.supabase.co", publishableKey: "sb_publishable_offline_test" },
    workspaces: [{ tenantId: "tenant-a", workspaceId: "workspace-a", dataDir, stateDir,
      wpmPath: join(corpusDir, "voice_wpm.json"), credentials: { env: { ELEVENLABS_API_KEY: "fake-only" } } }] };
  for (const queueDir of [root, dataDir, join(dataDir, "jobs"), stateDir, corpusDir])
    await rejects(startSupabaseCalibrationApi({ ...options, allowUnisolatedLocal: true, jobQueue: { dataDir: queueDir } }), /overlaps workspace/);
});

test("admission storage failure stops all subsequent dispatches", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "queue-admission-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const queue = await CalibrationJobQueue.open(root, 1);
  const save = queue.save.bind(queue); let first = true, paid = 0;
  queue.save = async (job) => {
    if (first) { first = false; throw new Error("simulated admission disk full"); }
    return save(job);
  };
  await rejects(queue.enqueue(identity(0), run(0), async () => {}), /disk full/);
  await rejects(queue.enqueue(identity(1), run(1), async () => { paid++; }), /storage failure/);
  strictEqual(paid, 0);
  await rejects(queue.close(), /owner lock retained/);
});

test("queue ownership survives engine shutdown and is retained when shutdown fails", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "queue-engine-shutdown-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const queue = await CalibrationJobQueue.open(root);
  let called = false;
  await rejects(queue.close(async () => {
    called = true;
    await rejects(CalibrationJobQueue.open(root), /EEXIST/);
    throw new Error("engine exit not confirmed");
  }), /engine exit not confirmed/);
  strictEqual(called, true);
  await rejects(CalibrationJobQueue.open(root), /EEXIST/);
});

test("confirmed engine shutdown releases ownership only after draining executions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "queue-confirmed-shutdown-"));
  let reopened;
  t.after(async () => { await reopened?.close(); await rm(root, { recursive: true, force: true }); });
  const queue = await CalibrationJobQueue.open(root);
  const running = deferred(), finished = deferred(), stopped = deferred();
  await queue.enqueue(identity(0), run(0), async () => ({ getRun: async () => run(0), execute: async () => {
    running.resolve(); await finished.promise; return { ...run(0), status: "succeeded" };
  } }));
  await running.promise;
  let shutdownCalled = false;
  const closing = queue.close(async () => {
    shutdownCalled = true;
    strictEqual((await queue.get(identity(0), "run-0")).status, "finished");
    await stopped.promise;
  });
  strictEqual(shutdownCalled, false);
  finished.resolve(); await until(() => shutdownCalled);
  await rejects(CalibrationJobQueue.open(root), /EEXIST/);
  stopped.resolve(); await closing;
  reopened = await CalibrationJobQueue.open(root);
  strictEqual((await reopened.get(identity(0), "run-0")).status, "finished");
});

test("duplicate HTTP enqueue does not call a busy MCP run reader", async (t) => {
  const { queue } = await fixture(t, 1);
  const hold = deferred(); let executing = false, unavailable = false, reads = 0;
  const app = { getSessionNonce: () => "nonce", getRun: async () => {
    reads++; if (unavailable) throw new Error("busy MCP reader"); return run(0);
  }, execute: async () => { executing = true; await hold.promise; return { ...run(0), status: "succeeded" }; } };
  const ui = await startCalibrationUi({ jobQueue: queue, closeApplications: async () => {},
    resolveApplication: async () => ({ application: app, workspaceId: identity(0).workspaceId,
      identity: { userId: identity(0).userId, tenantId: identity(0).tenantId } }) });
  t.after(() => ui.close());
  const submit = () => fetch(`${ui.url}/api/v1/calibration-runs/run-0/enqueue`, { method: "POST",
    headers: { "x-calibration-nonce": "nonce", "content-type": "application/json" }, body: "{}" });
  strictEqual((await submit()).status, 202);
  await until(() => executing); const before = reads; unavailable = true;
  const duplicate = await submit(); strictEqual(duplicate.status, 202);
  strictEqual((await duplicate.json()).status, "running"); strictEqual(reads, before);
  hold.resolve();
  await until(async () => (await queue.get(identity(0), "run-0")).status === "finished");
});
