// Offline Linux experiment: installed Python core, fake provider, durable private workspaces.
import { strictEqual, deepStrictEqual, rejects } from "node:assert";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { EngineManager } from "/opt/node/dist/calibration/engine-manager.js";
import { NodeMcpStdioTransport } from "/opt/node/dist/calibration/bridge.js";
import { createVoiceCalibrationApplication } from "/opt/node/dist/calibration/entrypoint.js";

const count = Number(process.argv[2]);
const resume = process.argv[3] === "resume";
const startLimit = Number(process.argv[4] ?? count);
const repeats = Number(process.argv[5] ?? 1);
strictEqual(Number.isSafeInteger(startLimit) && startLimit > 0, true);
strictEqual(Number.isSafeInteger(repeats) && repeats > 0, true);
strictEqual([1, 5, 10, 20].includes(count), true);
const root = "/data/benchmark";
const metadataPath = join(root, "metadata.json");
mkdirSync(root, { recursive: true });
const text = "Cette narration synthétique vérifie uniquement la concurrence et la persistance. ".repeat(24);
const params = (alias) => ({ voice_id: alias === "BenchmarkVoice" ? "BENCHMARKVOICE0000001" : "BENCHMARKCRASH0000001",
  model_id: "eleven_multilingual_v2", corpus_key: alias, language: "fr", runs: 5, mode: "precision",
  voice_settings: { stability: 0.65, similarity_boost: 0.75, style: 0, use_speaker_boost: true, speed: 1 } });
if (!resume) {
  const setup = spawnSync("/opt/venv/bin/python", ["/opt/benchmark-profiles.py", root, String(count)], { encoding: "utf8" });
  strictEqual(setup.status, 0, setup.stderr);
}
const workspaces = Array.from({ length: count }, (_, index) => ({
  tenantId: `tenant-${index}`, workspaceId: `workspace-${index}`, dataDir: join(root, String(index), "ui"),
  stateDir: join(root, String(index), "state"), wpmPath: join(root, String(index), "corpus/voice_wpm.json"),
  credentials: { env: { ELEVENLABS_API_KEY: `benchmark-fake-${index}` } },
}));
const transports = new Map();
const starts = [];
let activeStarts = 0;
let maxActiveStarts = 0;
let phase = "startup";
const samples = [];
function numbers(path) {
  if (!existsSync(path)) return {};
  return Object.fromEntries(readFileSync(path, "utf8").trim().split("\n").map((line) => {
    const [key, value] = line.trim().split(/\s+/u); return [key.replace(/:$/u, ""), Number(value)];
  }));
}
function cgroup() {
  const base = "/sys/fs/cgroup";
  return { memoryBytes: Number(readFileSync(join(base, "memory.current"), "utf8")),
    cpu: numbers(join(base, "cpu.stat")), events: numbers(join(base, "memory.events")) };
}
function sample() {
  const engines = [];
  for (const [workspaceId, transport] of transports) {
    const pid = transport.child?.pid;
    if (!pid || !existsSync(`/proc/${pid}/status`)) continue;
    try {
      const status = numbers(`/proc/${pid}/status`);
      const rollup = numbers(`/proc/${pid}/smaps_rollup`);
      if (Number.isFinite(status.VmRSS)) engines.push({ workspaceId, pid,
        rssBytes: status.VmRSS * 1024, pssBytes: rollup.Pss * 1024, peakRssBytes: status.VmHWM * 1024 });
    } catch (error) { if (!["ENOENT", "ESRCH"].includes(error.code)) throw error; }
  }
  samples.push({ phase, timeMs: performance.now(), cgroup: cgroup(), nodeRssBytes: process.memoryUsage().rss, engines });
}
const manager = new EngineManager(workspaces.map((options) => ({ workspaceId: options.workspaceId, async create() {
  const transport = new NodeMcpStdioTransport("/opt/venv/bin/python", ["/opt/fixtures/benchmark-worker.py"], "/opt/fixtures",
    { ...options, uiWorkspaceDir: join(options.dataDir, "workspaces", options.workspaceId) });
  transports.set(options.workspaceId, transport);
  const started = performance.now();
  maxActiveStarts = Math.max(maxActiveStarts, ++activeStarts);
  let application;
  try {
    application = await createVoiceCalibrationApplication({ ...options, mcpTransport: transport });
  } catch (error) {
    starts.push({ workspaceId: options.workspaceId, phase, startupMs: performance.now() - started,
      status: "FAILED", error: error.message });
    throw error;
  } finally { activeStarts--; }
  starts.push({ workspaceId: options.workspaceId, phase, startupMs: performance.now() - started,
    status: "PASS", pid: transport.child.pid });
  return application;
} })), { maxConcurrentStarts: startLimit });
const receipts = (index) => {
  const file = join(workspaces[index].stateDir, "fake-provider-receipts.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).length : 0;
};
const observed = (index) => JSON.parse(readFileSync(workspaces[index].wpmPath, "utf8")).BenchmarkVoice.observed_runs.length;
async function assertNoReplay(app, workspaceId, runId) {
  // The persistent gate can return the same uncertain run or reject; neither may synthesize.
  const result = await app.execute(workspaceId, runId).then((value) => value, () => null);
  if (result) strictEqual(result.status, "execution_unknown");
}
const metrics = [];
async function timed(label, action) {
  phase = label;
  sample();
  const before = cgroup();
  const started = performance.now();
  const details = await action();
  sample();
  const after = cgroup();
  const status = details?.failures?.length ? "FAILED" : "PASS";
  metrics.push({ phase: label, status, details, elapsedMs: performance.now() - started,
    cpuUsec: after.cpu.usage_usec - before.cpu.usage_usec,
    throttledUsec: after.cpu.throttled_usec - before.cpu.throttled_usec });
  console.log(JSON.stringify({ phase: label, count, status }));
}
const interval = setInterval(sample, 250);
let metadata;
let report;
try {
  await timed(resume ? "restore-startup-sequential" : "startup-sequential", async () => {
    for (const { workspaceId } of workspaces) await manager.start(workspaceId);
  });
  if (resume) {
    metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    const before = workspaces.map((_, index) => receipts(index));
    for (let index = 0; index < count; index++) {
      const app = manager.application(workspaces[index].workspaceId);
      strictEqual((await app.getRun(workspaces[index].workspaceId, metadata.runs[index].id)).status, "succeeded");
      strictEqual((await app.listVoiceProfiles(workspaces[index].workspaceId)).length, 1);
      strictEqual(observed(index), 5);
      deepStrictEqual(await app.getReport(workspaces[index].workspaceId, metadata.runs[index].id), metadata.reports[index]);
    }
    const app = manager.application(workspaces[0].workspaceId);
    await app.getBootstrap(workspaces[0].workspaceId);
    strictEqual((await app.getRun(workspaces[0].workspaceId, metadata.crashRun.id)).status, "execution_unknown");
    await assertNoReplay(app, workspaces[0].workspaceId, metadata.crashRun.id);
    deepStrictEqual(workspaces.map((_, index) => receipts(index)), before);
  } else {
    const runs = await Promise.all(workspaces.map(async ({ workspaceId }) => {
      const app = manager.application(workspaceId);
      const { draft } = await app.getDraft(workspaceId);
      const saved = await app.saveDraft(workspaceId, { ...draft, items: [{ id: "narration", order: 0, text }] }, draft.revision);
      await app.publishCorpusVersion(workspaceId, saved.revision);
      const run = await app.prepareDryRun({ workspaceId, voiceRef: "BenchmarkVoice", postproc: "cut", params: params("BenchmarkVoice") });
      await rejects(app.execute(workspaceId, run.id));
      await app.approve(workspaceId, run.id, { requestDigest: run.requestDigest });
      return run;
    }));
    strictEqual(workspaces.every((_, index) => receipts(index) === 0), true);
    await timed("simulated-calibrations-concurrent", async () => {
      await Promise.all(runs.map(async (run) => {
        const app = manager.application(run.workspaceId);
        const results = await Promise.allSettled([app.execute(run.workspaceId, run.id), app.execute(run.workspaceId, run.id)]);
        strictEqual(results.filter((result) => result.status === "fulfilled").length, 1);
        strictEqual(results.find((result) => result.status === "fulfilled").value.status, "succeeded");
        await app.publishProfile(run.workspaceId, run.id);
      }));
    });
    for (let index = 0; index < count; index++) {
      strictEqual(receipts(index), 5);
      strictEqual(observed(index), 5);
      if (count > 1) strictEqual(await manager.application(workspaces[index].workspaceId)
        .getRun(workspaces[index].workspaceId, runs[(index + 1) % count].id), null);
    }
    const app = manager.application(workspaces[0].workspaceId);
    const crashRun = await app.prepareDryRun({ workspaceId: workspaces[0].workspaceId,
      voiceRef: "CrashVoice", postproc: "cut", params: params("CrashVoice") });
    await app.approve(workspaces[0].workspaceId, crashRun.id, { requestDigest: crashRun.requestDigest });
    await timed("crash-and-explicit-replacement", async () => {
      const executing = app.execute(workspaces[0].workspaceId, crashRun.id)
        .then((value) => ({ value }), (error) => ({ error }));
      const deadline = Date.now() + 15000;
      while (receipts(0) === 5) {
        if (Date.now() > deadline) throw new Error("Crash coordination timed out");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const child = transports.get(workspaces[0].workspaceId).child;
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      const outcome = await executing;
      if (outcome.error) strictEqual(outcome.error.emitted, true);
      else strictEqual(outcome.value.status, "execution_unknown");
      await manager.restart(workspaces[0].workspaceId);
      await app.getBootstrap(workspaces[0].workspaceId);
      strictEqual((await app.getRun(workspaces[0].workspaceId, crashRun.id)).status, "execution_unknown");
      await assertNoReplay(app, workspaces[0].workspaceId, crashRun.id);
      strictEqual(receipts(0), 6);
    });
    const reports = await Promise.all(runs.map((run) => manager.application(run.workspaceId).getReport(run.workspaceId, run.id)));
    metadata = { runs, crashRun, reports, receipts: workspaces.map((_, index) => receipts(index)) };
    writeFileSync(metadataPath, JSON.stringify(metadata));
    for (let trial = 1; trial <= repeats; trial++) await timed(trial === 1
      ? "restart-all-concurrent" : `restart-all-concurrent-repeat-${trial}`, async () => {
      const restarts = workspaces.map(({ workspaceId }) => {
        const restart = manager.restart(workspaceId);
        strictEqual(manager.restart(workspaceId), restart);
        return restart;
      });
      const outcomes = await Promise.allSettled(restarts);
      return { failures: outcomes.flatMap((result, index) => result.status === "rejected"
        ? [{ workspaceId: workspaces[index].workspaceId, error: result.reason.message }] : []) };
    });
    strictEqual(starts.filter((start) => start.phase.startsWith("restart-all-concurrent")).length, count * repeats);
    await timed("injected-startup-failure-queue", async () => {
      let injectedActive = 0;
      let injectedPeak = 0;
      const suffixes = ["failure", ...Array.from({ length: startLimit + 1 }, (_, index) => `follower-${index}`)];
      const injected = new EngineManager(suffixes.map((suffix) => ({
        workspaceId: `queue-${suffix}`, async create() {
          injectedPeak = Math.max(injectedPeak, ++injectedActive);
          const directory = join(root, "failure-test", suffix);
          mkdirSync(directory, { recursive: true });
          const options = { tenantId: "queue-tenant", workspaceId: `queue-${suffix}`,
            dataDir: join(directory, "ui"), stateDir: join(directory, "state"),
            wpmPath: join(directory, "wpm.json"), credentials: { env: { ELEVENLABS_API_KEY: "benchmark-fake-queue" } } };
          writeFileSync(options.wpmPath, "{}");
          const args = suffix === "failure" ? ["-c", "raise RuntimeError('injected startup failure')"]
            : ["/opt/fixtures/benchmark-worker.py"];
          const transport = new NodeMcpStdioTransport("/opt/venv/bin/python", args, "/opt/fixtures",
            { ...options, uiWorkspaceDir: join(options.dataDir, "workspaces", options.workspaceId) });
          try { return await createVoiceCalibrationApplication({ ...options, mcpTransport: transport }); }
          finally { injectedActive--; }
        },
      })), { maxConcurrentStarts: startLimit });
      try {
        const results = await Promise.allSettled(suffixes.map((suffix) => injected.start(`queue-${suffix}`)));
        strictEqual(results[0].status, "rejected");
        deepStrictEqual(results.slice(1).map((result) => result.status), suffixes.slice(1).map(() => "fulfilled"));
        strictEqual(injectedPeak <= startLimit, true);
        return { injectedFailure: "observed", queuedFollowers: "PASS", maxConcurrentStartsObserved: injectedPeak };
      } finally { await injected.close(); }
    });
  }
  deepStrictEqual(workspaces.map((_, index) => receipts(index)), metadata.receipts);
  strictEqual(cgroup().events.oom_kill, 0);
  report = { status: metrics.some((metric) => metric.status === "FAILED") ? "DEGRADED" : "PASS",
    count, resume, startLimit, repeats, maxConcurrentStartsObserved: maxActiveStarts,
    realElevenLabsCalls: 0, starts, metrics, samples,
    receipts: metadata.receipts, observations: workspaces.map((_, index) => observed(index)),
    checks: ["explicit approval", "no duplicate fake synthesis", "private corpus", "persistent reports/profiles",
      "crash remains execution_unknown", "no replay after restart"],
    resources: { cpuMax: readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim(),
      memoryMax: readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim() },
    fixture: { allocationBytesPerCall: 32 * 1024 * 1024, sleepSecondsPerCall: 0.7,
      synthesesPerCalibration: 5, audioProcessing: "canned FakeDeps; no actual FFmpeg or provider" } };
} finally {
  clearInterval(interval);
  await manager.close();
}
writeFileSync(join(root, resume ? "restore-report.json" : "report.json"), JSON.stringify(report));
console.log("REPORT " + JSON.stringify(report));
