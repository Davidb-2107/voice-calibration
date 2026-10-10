import { strictEqual, deepStrictEqual } from "node:assert";
import { fork, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const restore = process.argv[2] === "restore";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const metrics = [];
const receiptCount = (index) => {
  const path = `/data/benchmark/${index}/state/fake-provider-receipts.jsonl`;
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).length : 0;
};
const observations = (index) => Object.values(JSON.parse(readFileSync(`/data/benchmark/${index}/corpus/voice_wpm.json`, "utf8")))
  .filter((value) => value && typeof value === "object").reduce((sum, value) => sum + (value.observed_runs?.length ?? 0), 0);
function processes(group) {
  return readdirSync("/proc").filter((name) => /^\d+$/u.test(name)).flatMap((name) => {
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8").split(") ")[1].split(" ");
      if (stat[0] === "Z") return [];
      if (group && Number(stat[2]) !== group) return [];
      const command = readFileSync(`/proc/${name}/comm`, "utf8").trim();
      return [{ pid: Number(name), command }];
    } catch (error) { if (["ENOENT", "ESRCH"].includes(error.code)) return []; throw error; }
  });
}
async function until(check, label, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) { if (Date.now() >= deadline) throw new Error(`Timeout: ${label}`); await sleep(50); }
}
function sample() {
  const jobs = existsSync("/data/jobs") ? readdirSync("/data/jobs").filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join("/data/jobs", name), "utf8"))) : [];
  metrics.push({ timeMs: performance.now(), running: jobs.filter((job) => job.status === "running").length,
    memoryBytes: Number(readFileSync("/sys/fs/cgroup/memory.current", "utf8")),
    pythonCount: processes().filter((row) => row.command.startsWith("python")).length });
}
let child, apiUrl, sampler, diagnostic;
const starts = [];
async function launch() {
  child = fork("/opt/queue-api.mjs", [], { detached: true, stdio: ["ignore", "inherit", "inherit", "ipc"] });
  const ready = new Promise((resolve, reject) => {
    child.on("message", (message) => {
      if (message.phase === "engine") starts.push(message);
      if (message.phase === "diagnostics") console.log("DIAGNOSTICS " + JSON.stringify(message));
      if (message.phase === "ready") { apiUrl = message.url; resolve(); }
    });
    child.once("exit", (code) => reject(new Error(`API exited before ready: ${code}`)));
  });
  await ready;
}
async function close() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit"); child.send("close");
  const [code] = await exited; strictEqual(code, 0);
  strictEqual(processes(child.pid).length, 0);
}
async function call(index, path, method = "GET", body, nonce, extra = {}) {
  const response = await fetch(`${apiUrl}/api/v1/${path}`, { method, headers: { authorization: `Bearer user-${index}`,
    "content-type": "application/json", ...(nonce ? { "x-calibration-nonce": nonce } : {}), ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120_000) });
  return { status: response.status, body: await response.json() };
}
const expected = (response, status) => { strictEqual(response.status, status, JSON.stringify(response.body)); return response.body; };
async function prepare(index, fixture, voiceRef = "BenchmarkVoice") {
  const boot = expected(await call(index, "bootstrap"), 200), nonce = boot.sessionNonce;
  const corpus = expected(await call(index, "corpus/draft"), 200);
  const draft = expected(await call(index, "corpus/draft", "PUT", { ...corpus,
    items: [{ id: "narration", order: 0, text: fixture.text }] }, nonce, { "if-match": String(corpus.revision) }), 200);
  expected(await call(index, "corpus/versions", "POST", { expectedRevision: draft.revision }, nonce), 201);
  const run = expected(await call(index, "calibration-runs/dry-run", "POST", { input: { voiceRef, postproc: "cut", params: {
    voice_id: voiceRef === "CrashVoice" ? "BENCHMARKCRASH0000001" : "BENCHMARKVOICE0000001",
    model_id: "eleven_multilingual_v2", corpus_key: voiceRef, language: "fr", mode: "precision", runs: 5,
    voice_settings: { stability: 0.65, similarity_boost: 0.75, style: 0, use_speaker_boost: true, speed: 1 } } } }, nonce), 201);
  expected(await call(index, `calibration-runs/${run.id}/approve`, "POST", { requestDigest: run.requestDigest }, nonce), 200);
  return { index, id: run.id, nonce };
}
async function enqueue(run) {
  const boot = expected(await call(run.index, "bootstrap"), 200);
  return expected(await call(run.index, `calibration-runs/${run.id}/enqueue`, "POST", {}, boot.sessionNonce), 202);
}
function durableJob(run) {
  return readdirSync("/data/jobs").filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join("/data/jobs", name), "utf8"))).find((job) => job.runId === run.id);
}
try {
  mkdirSync("/data", { recursive: true });
  if (!restore) {
    const tests = spawnSync("npm", ["test"], { cwd: "/opt/node", encoding: "utf8", timeout: 120_000 });
    writeFileSync("/data/node-tests.log", tests.stdout + tests.stderr); strictEqual(tests.status, 0, tests.stdout.slice(-5000));
    const setup = spawnSync("/opt/venv/bin/python", ["/opt/benchmark-profiles.py", "/data/benchmark", "100"], { encoding: "utf8" });
    strictEqual(setup.status, 0, setup.stderr);
    const prepared = spawnSync("/opt/venv/bin/python", ["/opt/prepare-audio.py"], { encoding: "utf8" });
    strictEqual(prepared.status, 0, prepared.stderr);
    const readiness = spawnSync("/opt/venv/bin/python", ["/opt/queue-readiness.py", "before"], { encoding: "utf8" });
    strictEqual(readiness.status, 0, readiness.stderr);
    writeFileSync("/data/revoked.json", "[]");
  }
  await launch();
  sample(); strictEqual(metrics.at(-1).pythonCount, 0);
  sampler = setInterval(sample, 100);
  diagnostic = setInterval(() => { if (child?.connected) child.send("diagnostics"); }, 20_000);
  if (!restore) {
    const fixture = JSON.parse(readFileSync("/data/audio-inputs/metadata.json", "utf8"))[0];
    const runs = [];
    for (const index of [0, 1, 2, 3, 4, 5, 6, 7, 8]) runs.push(await prepare(index, fixture));
    const settled = await Promise.all(runs.slice(0, 8).map(enqueue));
    deepStrictEqual(settled.map((job) => job.status), Array(8).fill("queued"));
    await Promise.all(Array.from({ length: 8 }, () => enqueue(runs[0])));
    await until(() => runs.slice(0, 8).every((run) => durableJob(run)?.status === "finished"), "eight queued audio calibrations");
    for (const run of runs.slice(0, 8)) {
      const result = expected(await call(run.index, `calibration-runs/${run.id}`), 200); strictEqual(result.status, "succeeded");
      const boot = expected(await call(run.index, "bootstrap"), 200);
      expected(await call(run.index, "voice-profiles", "POST", { runId: run.id }, boot.sessionNonce), 201);
      strictEqual(observations(run.index), 5); strictEqual(receiptCount(run.index), 5);
    }
    expected(await call(1, `calibration-runs/${runs[0].id}`), 404);
    expected(await call(1, `calibration-runs/${runs[0].id}/job`), 404);
    await until(() => processes().filter((row) => row.command.startsWith("python")).length === 0, "idle shutdown");
    const crash = await prepare(90, fixture, "CrashVoice"), waiting = await prepare(91, fixture);
    writeFileSync("/data/crash-hold", "hold");
    await enqueue(crash);
    await until(() => receiptCount(90) === 1, "crash response boundary");
    // Four held attempts fill the queue so two additional jobs cannot dispatch before the crash.
    const held = [crash];
    for (const index of [92, 93, 94]) {
      const run = await prepare(index, fixture, "CrashVoice"); held.push(run);
      await enqueue(run);
    }
    await until(() => held.every((run) => durableJob(run)?.status === "running"), "four occupied slots");
    await enqueue(waiting); await enqueue(runs[8]);
    writeFileSync("/data/revoked.json", "[8]");
    strictEqual(receiptCount(91), 0); strictEqual(receiptCount(8), 0);
    const group = child.pid, exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    const survivors = processes(group); strictEqual(survivors.some((row) => row.command.startsWith("python")), true);
    process.kill(-group, "SIGKILL");
    await until(() => processes(group).length === 0, "supervised Python/FFmpeg termination");
    for (const name of readdirSync("/data/jobs").filter((name) => name.endsWith(".lock"))) rmSync(join("/data/jobs", name));
    rmSync("/data/crash-hold");
    await launch();
    for (const run of held) strictEqual(durableJob(run).status, "execution_unknown");
    strictEqual(durableJob(waiting).status, "awaiting_authentication");
    strictEqual(durableJob(runs[8]).status, "awaiting_authentication");
    expected(await call(8, "bootstrap"), 403); strictEqual(receiptCount(8), 0);
    const crashBoot = expected(await call(90, "bootstrap"), 200);
    expected(await call(90, `calibration-runs/${crash.id}/execute`, "POST", {}, crashBoot.sessionNonce), 409);
    const reconciled = expected(await call(90, `calibration-runs/${crash.id}/reconcile`, "POST", {}, crashBoot.sessionNonce), 200);
    strictEqual(reconciled.status, "execution_unknown"); strictEqual(receiptCount(90), 1); strictEqual(observations(90), 0);
    await enqueue(waiting);
    await until(() => durableJob(waiting).status === "finished", "fresh authenticated waiting job");
    const boot = expected(await call(91, "bootstrap"), 200);
    expected(await call(91, "voice-profiles", "POST", { runId: waiting.id }, boot.sessionNonce), 201);
    strictEqual(observations(91), 5); strictEqual(receiptCount(91), 5);
    const record = { runs: [...runs, ...held, waiting], completed: [...runs.slice(0, 8), waiting],
      receipts: Array.from({ length: 100 }, (_, index) => receiptCount(index)), survivors, crashRunId: crash.id };
    writeFileSync("/data/queue-manifest.json", JSON.stringify(record));
  } else {
    const record = JSON.parse(readFileSync("/data/queue-manifest.json", "utf8"));
    for (const run of record.completed) {
      strictEqual(expected(await call(run.index, `calibration-runs/${run.id}`), 200).status, "succeeded");
      strictEqual(expected(await call(run.index, "voice-profiles"), 200).length, 1);
      strictEqual(observations(run.index), 5); strictEqual(durableJob(run).status, "finished");
    }
    deepStrictEqual(Array.from({ length: 100 }, (_, index) => receiptCount(index)), record.receipts);
    expected(await call(8, "bootstrap"), 403);
    strictEqual(record.runs.filter((run) => durableJob(run)?.status === "execution_unknown").length, 4);
  }
  await close(); sample(); strictEqual(metrics.at(-1).pythonCount, 0);
  const readiness = spawnSync("/opt/venv/bin/python", ["/opt/queue-readiness.py", restore ? "restore" : "after"], { encoding: "utf8" });
  strictEqual(readiness.status, 0, readiness.stderr);
  const peakRunning = Math.max(...metrics.map((row) => row.running)); strictEqual(peakRunning <= 4, true);
  const rows = Array.from({ length: 100 }, (_, index) => {
    const path = `/data/benchmark/${index}/state/audio-metrics.jsonl`;
    return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  }).flat();
  for (const row of rows) for (const d of row.durations) strictEqual(d.duration_raw_s > d.duration_trimmed_s && d.duration_trimmed_s > d.duration_s && d.duration_s > 0, true);
  const report = { status: "PASS", restore, registered: 100, maxConcurrentJobs: 4, peakRunning, starts, metrics,
    receipts: Array.from({ length: 100 }, (_, index) => receiptCount(index)), verifiedAudioCalibrations: rows.length,
    realElevenLabsCalls: 0, finalPythonProcesses: metrics.at(-1).pythonCount,
    nodeTestsTail: readFileSync("/data/node-tests.log", "utf8").slice(-350),
    onboarding: JSON.parse(readiness.stdout),
    checks: ["real HTTP/MCP/FFmpeg", "private tenants", "persistent queue", "duplicate no extra synthesis",
      "idle shutdown", "API SIGKILL and supervised child termination", "unknown no replay", "fresh session resumes waiting",
      "revoked tenant denied", "container restoration without synthesis"] };
  writeFileSync(`/data/queue-${restore ? "restore" : "run"}-report.json`, JSON.stringify(report));
  console.log("REPORT " + JSON.stringify(report));
} finally {
  clearInterval(sampler);
  clearInterval(diagnostic);
  if (child && child.exitCode === null && child.signalCode === null) {
    try { await close(); } catch { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
  }
}
