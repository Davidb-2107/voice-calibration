import { test } from "node:test";
import { deepStrictEqual, rejects, strictEqual, throws } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineManager } from "../dist/calibration/engine-manager.js";
import { createCalibrationApplication } from "../dist/calibration/application.js";
import { createLocalStore } from "../dist/calibration/ports.js";
import { startCalibrationUi } from "../dist/calibration/http-server.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("idle timeout validates and the default stops after ten minutes without keeping timers alive", async (t) => {
  for (const idleTimeoutMs of [0, -1, 1.5, NaN, Infinity, "100", null, 2_147_483_648])
    throws(() => new EngineManager([], { idleTimeoutMs }), /idleTimeoutMs/);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let closed = 0;
  const stopped = deferred();
  const manager = new EngineManager([{ workspaceId: "a", async create() {
    return { async close() { closed++; stopped.resolve(); } };
  } }]);
  t.after(() => manager.close());
  await manager.start("a");
  t.mock.timers.tick(599_999);
  strictEqual(closed, 0);
  t.mock.timers.tick(1);
  await stopped.promise;
  await manager.application("a").close();
  strictEqual(closed, 1);
});

test("idle countdown waits for operations and resets after success or failure", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const finish = deferred();
  let closed = 0;
  const stopped = deferred();
  const manager = new EngineManager([{ workspaceId: "a", async create() {
    return { async execute() { await finish.promise; return "done"; },
      async getRun() { throw new Error("read failed"); }, async close() { closed++; stopped.resolve(); } };
  } }], { idleTimeoutMs: 100 });
  t.after(() => manager.close());
  await manager.start("a");
  t.mock.timers.tick(90);
  const execution = manager.application("a").execute();
  t.mock.timers.tick(1000);
  strictEqual(closed, 0);
  finish.resolve();
  strictEqual(await execution, "done");
  t.mock.timers.tick(90);
  await rejects(manager.application("a").getRun(), /read failed/);
  t.mock.timers.tick(99);
  strictEqual(closed, 0);
  t.mock.timers.tick(1);
  await stopped.promise;
  await manager.application("a").close();
  strictEqual(closed, 1);
});

test("idle shutdown cannot interrupt a factory and requests arriving during shutdown share one wake", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ready = deferred();
  const entered = deferred();
  const closing = deferred();
  const closeStarted = deferred();
  let created = 0;
  let closed = 0;
  const manager = new EngineManager([{ workspaceId: "a", async create() {
    created++; entered.resolve(); await ready.promise;
    return { async close() { closed++; closeStarted.resolve(); await closing.promise; } };
  } }], { idleTimeoutMs: 100 });
  t.after(() => manager.close());
  const starting = manager.start("a");
  await entered.promise;
  t.mock.timers.tick(1000);
  strictEqual(closed, 0);
  ready.resolve();
  await starting;
  t.mock.timers.tick(100);
  await closeStarted.promise;
  const wakes = [manager.start("a"), manager.start("a")];
  strictEqual(created, 1);
  closing.resolve();
  await Promise.all(wakes);
  strictEqual(created, 2);
  strictEqual(closed, 1);
});

test("failed idle shutdown blocks demand until explicit recovery and never duplicates a process", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let created = 0;
  let fail = true;
  const manager = new EngineManager([{ workspaceId: "a", async create() {
    created++;
    return { async close() { if (fail) throw new Error("unconfirmed exit"); }, async getRun() { return "ready"; } };
  } }], { idleTimeoutMs: 100 });
  t.after(() => manager.close());
  await manager.start("a");
  t.mock.timers.tick(100);
  // Await the shared automatic transition and let its failure handler settle.
  await rejects(manager.application("a").close(), /unconfirmed exit/);
  await rejects(manager.start("a"), /Automatic engine shutdown failed/);
  strictEqual(created, 1);
  fail = false;
  await manager.restart("a");
  strictEqual(created, 2);
  strictEqual(await manager.application("a").getRun(), "ready");
});

test("100 dormant registrations create no engines; explicit stop and wake retain the facade", async (t) => {
  const created = [];
  const closed = [];
  const manager = new EngineManager(Array.from({ length: 100 }, (_, index) => ({
    workspaceId: `workspace-${index}`, async create() {
      created.push(index);
      return { async getRun() { return index; }, async close() { closed.push(index); } };
    },
  })));
  t.after(() => manager.close());
  for (let index = 0; index < 100; index++) manager.application(`workspace-${index}`);
  deepStrictEqual(created, []);
  const facade = manager.application("workspace-49");
  await Promise.all(Array.from({ length: 8 }, () => manager.start("workspace-49")));
  deepStrictEqual(created, [49]);
  await facade.close();
  deepStrictEqual(closed, [49]);
  await manager.start("workspace-49");
  strictEqual(manager.application("workspace-49"), facade);
  strictEqual(await facade.getRun(), 49);
  deepStrictEqual(created, [49, 49]);
});

test("startup limit validates before IO and FIFO failures release their permit", async (t) => {
  for (const limit of [0, -1, 1.5, NaN, Infinity, "2", null])
    throws(() => new EngineManager([], { maxConcurrentStarts: limit }), /positive safe integer/);
  let active = 0;
  let maximum = 0;
  const order = [];
  const entered = deferred();
  const release = deferred();
  const manager = new EngineManager(["a", "b", "c", "d"].map((workspaceId) => ({ workspaceId, async create() {
    order.push(workspaceId);
    maximum = Math.max(maximum, ++active);
    if (order.length === 2) entered.resolve();
    try {
      await release.promise;
      if (workspaceId === "a") throw new Error("injected startup failure");
      return { async close() {} };
    } finally { active--; }
  } })), { maxConcurrentStarts: 2 });
  t.after(() => manager.close());
  const attempts = ["a", "b", "c", "d"].map((id) => manager.start(id));
  const outcomes = Promise.allSettled(attempts);
  await entered.promise;
  deepStrictEqual(order, ["a", "b"]);
  release.resolve();
  strictEqual((await outcomes).filter((result) => result.status === "rejected").length, 1);
  deepStrictEqual(order, ["a", "b", "c", "d"]);
  strictEqual(maximum, 2);
});

test("closing a manager with queued startups never creates the queued engines", async () => {
  const entered = deferred();
  const ready = deferred();
  const created = [];
  const closed = [];
  const manager = new EngineManager(["a", "b", "c"].map((id) => ({ workspaceId: id, async create() {
    created.push(id); entered.resolve(); await ready.promise;
    return { async close() { closed.push(id); } };
  } })), { maxConcurrentStarts: 1 });
  const attempts = ["a", "b", "c"].map((id) => manager.start(id));
  await entered.promise;
  const stopping = manager.close();
  ready.resolve();
  await Promise.all([...attempts, stopping]);
  deepStrictEqual(created, ["a"]);
  deepStrictEqual(closed, ["a"]);
});

test("concurrent starts/restarts share a process and reject unregistered workspaces", async (t) => {
  let created = 0;
  let closed = 0;
  const ready = deferred();
  const manager = new EngineManager([{ workspaceId: "workspace-a", async create() {
    created++;
    await ready.promise;
    return { async getRun() { return created; }, async close() { closed++; } };
  } }]);
  t.after(() => manager.close());
  throws(() => manager.application("foreign"), /Unregistered/);
  throws(() => new EngineManager([{ workspaceId: "a" }, { workspaceId: "a" }]), /Duplicate/);
  const starts = [manager.start("workspace-a"), manager.start("workspace-a")];
  ready.resolve();
  await Promise.all(starts);
  strictEqual(created, 1);
  const facade = manager.application("workspace-a");
  await Promise.all([manager.restart("workspace-a"), manager.restart("workspace-a")]);
  strictEqual(created, 2);
  strictEqual(closed, 1);
  strictEqual(manager.application("workspace-a"), facade);
  strictEqual(await facade.getRun(), 2);
  await manager.close();
  strictEqual(closed, 2);
  await rejects(manager.start("workspace-a"), /closed/);
});

test("restart drains an in-flight execution once and leaves another workspace available", async (t) => {
  const entered = deferred();
  const finish = deferred();
  let executions = 0;
  const events = [];
  const manager = new EngineManager(["a", "b"].map((workspaceId) => ({ workspaceId, async create() {
    events.push(`create-${workspaceId}`);
    return { async execute() { executions++; entered.resolve(); await finish.promise; return "done"; },
      async getRun() { return workspaceId; }, async close() { events.push(`close-${workspaceId}`); } };
  } })));
  t.after(() => manager.close());
  await Promise.all([manager.start("a"), manager.start("b")]);
  const execution = manager.application("a").execute();
  await entered.promise;
  const restarting = manager.restart("a");
  throws(() => manager.application("a").getRun(), /unavailable/);
  strictEqual(await manager.application("b").getRun(), "b");
  deepStrictEqual(events, ["create-a", "create-b"]);
  finish.resolve();
  strictEqual(await execution, "done");
  await restarting;
  strictEqual(executions, 1);
  deepStrictEqual(events, ["create-a", "create-b", "close-a", "create-a"]);
});

test("close during startup cleans the created engine and does not admit operations", async () => {
  const ready = deferred();
  const entered = deferred();
  let closed = 0;
  const manager = new EngineManager([{ workspaceId: "a", async create() {
    entered.resolve();
    await ready.promise;
    return { async close() { closed++; } };
  } }]);
  const starting = manager.start("a");
  await entered.promise;
  const closing = manager.close();
  ready.resolve();
  await Promise.all([starting, closing]);
  strictEqual(closed, 1);
  throws(() => manager.application("a").getRun(), /unavailable/);
});

test("failed shutdown blocks replacement and close still attempts all workspaces", async () => {
  let created = 0;
  const closed = [];
  const manager = new EngineManager(["a", "b"].map((workspaceId) => ({ workspaceId, async create() {
    created++;
    return { async close() { closed.push(workspaceId); if (workspaceId === "a") throw new Error("cannot stop"); } };
  } })));
  await Promise.all([manager.start("a"), manager.start("b")]);
  await rejects(manager.restart("a"), /cannot stop/);
  strictEqual(created, 2);
  throws(() => manager.application("a").getRun(), /unavailable/);
  await rejects(manager.close(), /shutdown failed/);
  deepStrictEqual(closed, ["a", "a", "b"]);
});

test("failed startup can be explicitly retried without replaying an operation", async (t) => {
  let attempts = 0;
  const manager = new EngineManager([{ workspaceId: "a", async create() {
    if (++attempts === 1) throw new Error("startup failed");
    return { async getRun() { return "ready"; }, async close() {} };
  } }]);
  t.after(() => manager.close());
  await rejects(manager.start("a"), /startup failed/);
  throws(() => manager.application("a").getRun(), /unavailable/);
  await manager.start("a");
  strictEqual(await manager.application("a").getRun(), "ready");
  strictEqual(attempts, 2);
});

test("closing one workspace drains errors, coalesces shutdown and preserves another engine", async (t) => {
  const finish = deferred();
  let closed = 0;
  const manager = new EngineManager(["a", "b"].map((workspaceId) => ({ workspaceId, async create() {
    return { getSessionNonce() { throw new Error("sync failure"); },
      async getRun() { if (workspaceId === "a") { await finish.promise; throw new Error("async failure"); } return "b"; },
      async close() { closed++; } };
  } })));
  t.after(() => manager.close());
  await Promise.all([manager.start("a"), manager.start("b")]);
  const app = manager.application("a");
  throws(() => app.getSessionNonce(), /sync failure/);
  const failed = rejects(app.getRun(), /async failure/);
  const closes = [app.close(), app.close()];
  await rejects(manager.start("a"), /stopping/);
  strictEqual(await manager.application("b").getRun(), "b");
  finish.resolve();
  await Promise.all([...closes, failed]);
  strictEqual(closed, 1);
});

test("the same HTTP API handle uses the replacement engine without route changes", async (t) => {
  let generation = 0;
  const manager = new EngineManager([{ workspaceId: "a", async create() {
    const current = ++generation;
    return { async getBootstrap() { return { generation: current }; }, async close() {} };
  } }]);
  await manager.start("a");
  const ui = await startCalibrationUi({
    resolveApplication: async () => ({ application: manager.application("a"), workspaceId: "a",
      identity: { userId: "test", tenantId: "tenant-a" } }), closeApplications: () => manager.close(),
  });
  t.after(() => ui.close());
  strictEqual((await (await fetch(`${ui.url}/api/v1/bootstrap`)).json()).generation, 1);
  await manager.restart("a");
  strictEqual((await (await fetch(`${ui.url}/api/v1/bootstrap`)).json()).generation, 2);
});

test("durable approvals, unknown executions, results and profiles survive replacement and a new manager", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "engine-persistence-"));
  const executions = [];
  const registrations = ["a", "b"].map((workspaceId) => ({ workspaceId, async create() {
    return createCalibrationApplication({ repositories: createLocalStore(join(root, workspaceId)),
      configurationIdentity: "v1:hmac-sha256:" + "a".repeat(64),
      bridge: { async getSchema() { return { type: "object", properties: {} }; },
        async dryRun() { return { accepted: true, plan: [], raw: {} }; },
        async execute(input) { executions.push(input.runId); return { status: workspaceId === "a" ? "succeeded" : "unknown",
          metrics: { wpm: 148 }, artifacts: [], raw: {} }; },
        async reconcile() { return { status: "unknown" }; }, async close() {} },
      canonical: { async ensurePublished() { return { canonicalRef: "python://private-wpm" }; } },
    });
  } }));
  let manager = new EngineManager(registrations);
  t.after(async () => { await manager.close(); rmSync(root, { recursive: true, force: true }); });
  const runs = [];
  for (const workspaceId of ["a", "b"]) {
    await manager.start(workspaceId);
    const app = manager.application(workspaceId);
    const { draft } = await app.getDraft(workspaceId);
    const saved = await app.saveDraft(workspaceId, { ...draft, items: [{ id: "one", order: 0, text: "Bonjour le monde." }] }, draft.revision);
    await app.publishCorpusVersion(workspaceId, saved.revision);
    const run = await app.prepareDryRun({ workspaceId, voiceRef: "test-voice", params: {}, postproc: "cut" });
    await app.approve(workspaceId, run.id, { requestDigest: run.requestDigest });
    await manager.restart(workspaceId);
    strictEqual((await app.getRun(workspaceId, run.id)).status, "approved");
    const attempts = await Promise.allSettled([app.execute(workspaceId, run.id), app.execute(workspaceId, run.id)]);
    strictEqual(attempts.filter((result) => result.status === "fulfilled").length, 1);
    strictEqual(attempts.filter((result) => result.status === "rejected").length, 1);
    if (workspaceId === "a") await app.publishProfile(workspaceId, run.id);
    runs.push(run);
  }
  const report = await manager.application("a").getReport("a", runs[0].id);
  const profiles = await manager.application("a").listVoiceProfiles("a");
  await manager.close();
  manager = new EngineManager(registrations);
  await Promise.all([manager.start("a"), manager.start("b")]);
  strictEqual((await manager.application("a").getRun("a", runs[0].id)).status, "succeeded");
  deepStrictEqual(await manager.application("a").getReport("a", runs[0].id), report);
  deepStrictEqual(await manager.application("a").listVoiceProfiles("a"), profiles);
  strictEqual((await manager.application("b").getRun("b", runs[1].id)).status, "execution_unknown");
  await rejects(manager.application("b").execute("b", runs[1].id), /reconcile|execution_unknown/);
  strictEqual(await manager.application("b").getRun("b", runs[0].id), null);
  strictEqual(executions.length, 2);
});
