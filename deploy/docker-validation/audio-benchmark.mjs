// Offline capacity experiment; production core/audio, local provider responses.
import { strictEqual, deepStrictEqual } from "node:assert";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { EngineManager } from "/opt/node/dist/calibration/engine-manager.js";
import { NodeMcpStdioTransport } from "/opt/node/dist/calibration/bridge.js";
import { createVoiceCalibrationApplication } from "/opt/node/dist/calibration/entrypoint.js";

const count = 20;
const repeats = Number(process.argv[2] ?? 3);
strictEqual(Number.isSafeInteger(repeats) && repeats > 0, true);
const root = "/data/benchmark";
mkdirSync(root, { recursive: true });
const setup = spawnSync("/opt/venv/bin/python", ["/opt/benchmark-profiles.py", root, String(count), String(repeats)], { encoding: "utf8" });
strictEqual(setup.status, 0, setup.stderr);
const prepared = spawnSync("/opt/venv/bin/python", ["/opt/prepare-audio.py"], { encoding: "utf8" });
strictEqual(prepared.status, 0, prepared.stderr);
const fixtures = JSON.parse(readFileSync("/data/audio-inputs/metadata.json", "utf8"));
const workspaces = Array.from({ length: count }, (_, index) => ({
  tenantId: `tenant-${index}`, workspaceId: `workspace-${index}`, dataDir: join(root, String(index), "ui"),
  stateDir: join(root, String(index), "state"), wpmPath: join(root, String(index), "corpus/voice_wpm.json"),
  credentials: { env: { ELEVENLABS_API_KEY: `benchmark-fake-${index}` } },
}));
const transports = new Map();
const samples = [];
const metrics = [];
let phase = "baseline";
function numbers(path) {
  return Object.fromEntries(readFileSync(path, "utf8").trim().split("\n").map((line) => {
    const [key, value] = line.trim().split(/\s+/u); return [key.replace(/:$/u, ""), Number(value)];
  }));
}
function cgroup() {
  return { memoryBytes: Number(readFileSync("/sys/fs/cgroup/memory.current", "utf8")),
    cpu: numbers("/sys/fs/cgroup/cpu.stat"), events: numbers("/sys/fs/cgroup/memory.events") };
}
function sample() {
  const engines = [];
  const audioProcesses = [];
  for (const name of readdirSync("/proc").filter((name) => /^\d+$/u.test(name))) {
    try {
      const status = numbers(`/proc/${name}/status`);
      const command = readFileSync(`/proc/${name}/comm`, "utf8").trim();
      const workspaceId = [...transports].find(([, transport]) => transport.child?.pid === Number(name))?.[0];
      if (!workspaceId && !["ffmpeg", "ffprobe"].includes(command)) continue;
      const rollup = numbers(`/proc/${name}/smaps_rollup`);
      const row = { pid: Number(name), rssBytes: status.VmRSS * 1024, pssBytes: rollup.Pss * 1024,
        peakRssBytes: status.VmHWM * 1024 };
      if (workspaceId) engines.push({ ...row, workspaceId });
      else audioProcesses.push({ ...row, command });
    } catch (error) { if (!["ENOENT", "ESRCH"].includes(error.code)) throw error; }
  }
  samples.push({ phase, timeMs: performance.now(), cgroup: cgroup(), nodeRssBytes: process.memoryUsage().rss,
    engines, audioProcesses });
}
const manager = new EngineManager(workspaces.map((options) => ({ workspaceId: options.workspaceId, async create() {
  const transport = new NodeMcpStdioTransport("/opt/venv/bin/python", ["/opt/fixtures/audio-benchmark-worker.py"], "/opt/fixtures",
    { ...options, uiWorkspaceDir: join(options.dataDir, "workspaces", options.workspaceId) });
  transports.set(options.workspaceId, transport);
  return createVoiceCalibrationApplication({ ...options, mcpTransport: transport });
} })), { maxConcurrentStarts: 4 });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const receiptCount = (options) => {
  const path = join(options.stateDir, "fake-provider-receipts.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).length : 0;
};
async function timed(label, action) {
  phase = label;
  sample();
  const before = cgroup();
  const started = performance.now();
  const details = await action();
  sample();
  const after = cgroup();
  const selected = samples.filter((row) => row.phase === label);
  const metric = { phase: label, elapsedMs: performance.now() - started,
    cpuSeconds: (after.cpu.usage_usec - before.cpu.usage_usec) / 1e6,
    throttledSeconds: (after.cpu.throttled_usec - before.cpu.throttled_usec) / 1e6,
    memoryStartBytes: before.memoryBytes, peakCgroupBytes: Math.max(...selected.map((row) => row.cgroup.memoryBytes)),
    enginePssPeakBytes: Math.max(...selected.map((row) => row.engines.reduce((sum, e) => sum + e.pssBytes, 0))),
    audioPssPeakBytes: Math.max(...selected.map((row) => row.audioProcesses.reduce((sum, e) => sum + e.pssBytes, 0))),
    maxAudioProcessesObserved: Math.max(...selected.map((row) => row.audioProcesses.length)), details };
  metrics.push(metric);
  console.log(JSON.stringify(metric));
}
const interval = setInterval(sample, 100);
try {
  await timed("idle-0", () => sleep(2000));
  let ready = 0;
  for (const target of [1, 5, 10, 20]) {
    phase = `start-${target}`;
    await Promise.all(workspaces.slice(ready, target).map(({ workspaceId }) => manager.start(workspaceId)));
    ready = target;
    await timed(`idle-${target}`, () => sleep(2000));
  }
  const allRuns = [];
  for (let trial = 0; trial < repeats; trial++) {
    const fixture = fixtures[trial % fixtures.length];
    for (const concurrency of [1, 5, 10, 20]) {
      phase = "prepare";
      const alias = `AudioVoice_${trial + 1}_${concurrency}`;
      const voiceId = `BENCHMARK${String(trial + 1).padStart(4, "0")}${String(concurrency).padStart(7, "0")}`;
      const active = workspaces.slice(0, concurrency);
      const runs = [];
      for (const options of active) {
        const app = manager.application(options.workspaceId);
        const { draft } = await app.getDraft(options.workspaceId);
        const saved = await app.saveDraft(options.workspaceId,
          { ...draft, items: [{ id: "narration", order: 0, text: fixture.text }] }, draft.revision);
        await app.publishCorpusVersion(options.workspaceId, saved.revision);
        const run = await app.prepareDryRun({ workspaceId: options.workspaceId, voiceRef: alias, postproc: "cut",
          params: { voice_id: voiceId, model_id: "eleven_multilingual_v2", corpus_key: alias,
            language: "fr", runs: 5, mode: "precision",
            voice_settings: { stability: 0.65, similarity_boost: 0.75, style: 0, use_speaker_boost: true, speed: 1 } } });
        await app.approve(options.workspaceId, run.id, { requestDigest: run.requestDigest });
        runs.push(run);
      }
      const before = active.map(receiptCount);
      await timed(`audio-${concurrency}-trial-${trial + 1}`, async () => {
        const results = await Promise.allSettled(runs.map(async (run) => {
          const started = performance.now();
          const app = manager.application(run.workspaceId);
          const outcome = await app.execute(run.workspaceId, run.id);
          strictEqual(outcome.status, "succeeded");
          await app.publishProfile(run.workspaceId, run.id);
          return { workspaceId: run.workspaceId, elapsedMs: performance.now() - started };
        }));
        const failures = results.filter((row) => row.status === "rejected").map((row) => String(row.reason));
        deepStrictEqual(failures, []);
        return { concurrency, trial: trial + 1, fixture: fixture.name, failures,
          latencies: results.map((row) => row.value) };
      });
      active.forEach((options, index) => strictEqual(receiptCount(options) - before[index], 5));
      allRuns.push(...runs);
      await timed(`settled-${concurrency}-trial-${trial + 1}`, () => sleep(1000));
    }
  }
  const expected = repeats * (1 + 5 + 10 + 20) * 5;
  strictEqual(workspaces.reduce((sum, options) => sum + receiptCount(options), 0), expected);
  for (const options of workspaces) {
    const corpus = JSON.parse(readFileSync(options.wpmPath, "utf8"));
    strictEqual(Object.values(corpus).filter((row) => row && typeof row === "object")
      .reduce((sum, row) => sum + (row.observed_runs?.length ?? 0), 0), receiptCount(options));
  }
  await manager.close();
  await timed("closed", () => sleep(1000));
  strictEqual(cgroup().events.oom_kill, 0);
  const workerMetrics = workspaces.map((options) => ({ workspaceId: options.workspaceId,
    rows: readFileSync(join(options.stateDir, "audio-metrics.jsonl"), "utf8").trim().split("\n").map(JSON.parse) }));
  const report = { status: "PASS", count, maxConcurrentStarts: 4, repeats, metrics, samples,
    calibrationCount: allRuns.length, localAudioResponses: expected, realElevenLabsCalls: 0, workerMetrics, fixtures,
    versions: ["ffmpeg", "ffprobe"].map((name) => ({ name, version: spawnSync(name, ["-version"], { encoding: "utf8" }).stdout.split("\n")[0] })),
    resources: { cpuMax: readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim(),
      memoryMax: readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim() } };
  writeFileSync(join(root, "audio-report.json"), JSON.stringify(report));
  console.log("REPORT " + JSON.stringify(report));
} finally {
  clearInterval(interval);
  await manager.close();
}
