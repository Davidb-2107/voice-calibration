// Offline lifecycle experiment: real Python MCP, mocked Supabase and provider.
import { strictEqual, deepStrictEqual } from "node:assert";
import { existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { EngineManager } from "/opt/node/dist/calibration/engine-manager.js";
import { NodeMcpStdioTransport } from "/opt/node/dist/calibration/bridge.js";
import { createVoiceCalibrationApplication } from "/opt/node/dist/calibration/entrypoint.js";
import { startCalibrationUi } from "/opt/node/dist/calibration/http-server.js";
import { createSupabaseWorkspaceResolver, validateTenantWorkspaces } from "/opt/node/dist/calibration/supabase-auth.js";

const root = "/data/benchmark";
const automaticIdle = process.argv[2] !== undefined;
const idleTimeoutMs = automaticIdle ? Number(process.argv[2]) : 600_000;
mkdirSync(root, { recursive: true });
const setup = spawnSync("/opt/venv/bin/python", ["/opt/benchmark-profiles.py", root, "100"], { encoding: "utf8" });
strictEqual(setup.status, 0, setup.stderr);
const resources = [];
function snapshot(phase) {
  const processes = readdirSync("/proc").filter((pid) => /^\d+$/u.test(pid)).flatMap((pid) => {
    try {
      const command = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
      if (!command.startsWith("python")) return [];
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      return [{ pid: Number(pid), rssKiB: Number(/VmRSS:\s+(\d+)/u.exec(status)?.[1] ?? 0) }];
    } catch (error) { if (["ENOENT", "ESRCH"].includes(error.code)) return []; throw error; }
  });
  const row = { phase, cgroupBytes: Number(readFileSync("/sys/fs/cgroup/memory.current", "utf8")),
    nodeRssBytes: process.memoryUsage().rss, nodeHeapBytes: process.memoryUsage().heapUsed, processes };
  resources.push(row);
  return row;
}
snapshot("before-registration");
const workspaces = validateTenantWorkspaces(Array.from({ length: 100 }, (_, index) => ({
  tenantId: `tenant-${index}`, workspaceId: `workspace-${index}`, dataDir: join(root, String(index), "ui"),
  stateDir: join(root, String(index), "state"), wpmPath: join(root, String(index), "corpus/voice_wpm.json"),
  credentials: { env: { ELEVENLABS_API_KEY: `benchmark-fake-${index}` } },
})));
const transports = new Map();
const starts = [];
const manager = new EngineManager(workspaces.map((options) => ({ workspaceId: options.workspaceId, async create() {
  const transport = new NodeMcpStdioTransport("/opt/venv/bin/python", ["/opt/fixtures/benchmark-worker.py"], "/opt/fixtures",
    { ...options, uiWorkspaceDir: join(options.dataDir, "workspaces", options.workspaceId) });
  transports.set(options.workspaceId, transport);
  const started = performance.now();
  const app = await createVoiceCalibrationApplication({ ...options, mcpTransport: transport });
  starts.push({ workspaceId: options.workspaceId, elapsedMs: performance.now() - started, pid: transport.child.pid });
  return app;
} })), { maxConcurrentStarts: 4, idleTimeoutMs });
const idleStops = [];
async function stopForTest(app, workspaceId) {
  const pid = transports.get(workspaceId).child?.pid;
  const started = performance.now();
  if (!automaticIdle) await app.close();
  else {
    const deadline = Date.now() + 15_000;
    while (pid && existsSync(`/proc/${pid}`)) {
      if (Date.now() > deadline) throw new Error("Automatic idle stop timed out");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (pid) strictEqual(existsSync(`/proc/${pid}`), false);
  idleStops.push({ workspaceId, pid, elapsedMs: performance.now() - started, automatic: automaticIdle });
}
const revoked = new Set();
const resolveApplication = createSupabaseWorkspaceResolver({ url: "https://offline.supabase.co",
  publishableKey: "sb_publishable_offline_test", fetch: async (url, options) => {
    const match = /^Bearer user-(\d+)$/u.exec(options.headers.authorization);
    const index = match ? Number(match[1]) : -1;
    if (index < 0 || index >= 100) return Response.json({}, { status: 401 });
    if (new URL(url).pathname === "/auth/v1/user") return Response.json({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, role: "authenticated",
      is_anonymous: false, email_confirmed_at: "2026-10-10T00:00:00Z" });
    return Response.json(revoked.has(index) ? [] : [{ id: `workspace-${index}`, tenant_id: `tenant-${index}` }]);
  } }, workspaces.map(({ tenantId, workspaceId }) => ({ tenantId, workspaceId, application: async () => {
    await manager.start(workspaceId);
    return manager.application(workspaceId);
  } })));
const ui = await startCalibrationUi({ resolveApplication, closeApplications: () => manager.close() });
const call = async (token, path = "bootstrap") => {
  const started = performance.now();
  const response = await fetch(`${ui.url}/api/v1/${path}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: response.status, body: await response.json(), elapsedMs: performance.now() - started };
};
const receipts = (index) => {
  const path = join(workspaces[index].stateDir, "fake-provider-receipts.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).length : 0;
};
const wake = [];
try {
  strictEqual(starts.length, 0);
  strictEqual(snapshot("100-registered-api-ready").processes.length, 0);
  strictEqual((await call("invalid")).status, 401);
  revoked.add(49);
  strictEqual((await call("user-49")).status, 403);
  strictEqual(starts.length, 0);
  revoked.delete(49);
  const concurrent = await Promise.all(Array.from({ length: 8 }, () => call("user-0")));
  deepStrictEqual(concurrent.map((r) => r.status), Array(8).fill(200));
  strictEqual(starts.length, 1);
  wake.push({ workspaceId: "workspace-0", reason: "first demand / 8 concurrent requests", requests: concurrent.map((r) => r.elapsedMs) });
  strictEqual(snapshot("one-demanded").processes.length, 1);
  strictEqual((await call("user-0", "bootstrap?workspaceId=workspace-49")).status, 400);
  strictEqual(starts.length, 1);
  const runs = [];
  for (const index of [0, 49, 99]) {
    const boot = await call(`user-${index}`);
    strictEqual(boot.status, 200);
    wake.push({ workspaceId: `workspace-${index}`, reason: index ? "first demand" : "warm demand", requests: [boot.elapsedMs] });
    const app = manager.application(`workspace-${index}`);
    const { draft } = await app.getDraft(`workspace-${index}`);
    const saved = await app.saveDraft(`workspace-${index}`, { ...draft,
      items: [{ id: "narration", order: 0, text: `Narration privée du workspace numéro ${index}. `.repeat(24) }] }, draft.revision);
    await app.publishCorpusVersion(`workspace-${index}`, saved.revision);
    const run = await app.prepareDryRun({ workspaceId: `workspace-${index}`, voiceRef: "BenchmarkVoice", postproc: "cut",
      params: { voice_id: "BENCHMARKVOICE0000001", model_id: "eleven_multilingual_v2", corpus_key: "BenchmarkVoice",
        language: "fr", mode: "precision", runs: 5,
        voice_settings: { stability: 0.65, similarity_boost: 0.75, style: 0, use_speaker_boost: true, speed: 1 } } });
    await app.approve(`workspace-${index}`, run.id, { requestDigest: run.requestDigest });
    const approved = await app.getRun(`workspace-${index}`, run.id);
    const corpus = readFileSync(workspaces[index].wpmPath, "utf8");
    await stopForTest(app, `workspace-${index}`);
    const beforeWake = starts.length;
    const responses = await Promise.all(Array.from({ length: 8 }, () => call(`user-${index}`)));
    deepStrictEqual(responses.map((r) => r.status), Array(8).fill(200));
    strictEqual(starts.length, beforeWake + 1);
    wake.push({ workspaceId: `workspace-${index}`, reason: "wake after stop / approval preserved", requests: responses.map((r) => r.elapsedMs) });
    deepStrictEqual(await app.getRun(`workspace-${index}`, run.id), approved);
    strictEqual(readFileSync(workspaces[index].wpmPath, "utf8"), corpus);
    strictEqual(receipts(index), 0);
    const executing = app.execute(`workspace-${index}`, run.id);
    if (automaticIdle) {
      await new Promise((resolve) => setTimeout(resolve, idleTimeoutMs + 200));
      strictEqual(existsSync(`/proc/${transports.get(`workspace-${index}`).child.pid}`), true);
    }
    strictEqual((await executing).status, "succeeded");
    await app.publishProfile(`workspace-${index}`, run.id);
    const report = await app.getReport(`workspace-${index}`, run.id);
    const profiles = await app.listVoiceProfiles(`workspace-${index}`);
    const publishedCorpus = readFileSync(workspaces[index].wpmPath, "utf8");
    await stopForTest(app, `workspace-${index}`);
    const restored = await call(`user-${index}`);
    strictEqual(restored.status, 200);
    wake.push({ workspaceId: `workspace-${index}`, reason: "wake after stop / published data", requests: [restored.elapsedMs] });
    deepStrictEqual(await app.getReport(`workspace-${index}`, run.id), report);
    deepStrictEqual(await app.listVoiceProfiles(`workspace-${index}`), profiles);
    strictEqual(readFileSync(workspaces[index].wpmPath, "utf8"), publishedCorpus);
    strictEqual(receipts(index), 5);
    runs.push(run);
  }
  const demandedProcesses = snapshot(automaticIdle ? "three-demanded-with-idle-stops" : "three-demanded-97-dormant").processes.length;
  if (automaticIdle) strictEqual(demandedProcesses >= 1 && demandedProcesses <= 3, true);
  else strictEqual(demandedProcesses, 3);
  for (const run of runs) {
    if (automaticIdle) strictEqual((await call(`user-${run.workspaceId.split("-")[1]}`)).status, 200);
    for (const other of runs.filter((r) => r.workspaceId !== run.workspaceId))
      strictEqual(await manager.application(run.workspaceId).getRun(run.workspaceId, other.id), null);
  }
  deepStrictEqual([...new Set(starts.map((s) => s.workspaceId))].sort(), ["workspace-0", "workspace-49", "workspace-99"]);
  if (automaticIdle) strictEqual(starts.length >= 9 && starts.length <= 12, true);
  else strictEqual(starts.length, 9);
  await Promise.all([0, 49, 99].map((index) => stopForTest(manager.application(`workspace-${index}`), `workspace-${index}`)));
  strictEqual(snapshot("all-stopped").processes.length, 0);
  const report = { status: "PASS", registered: 100, demanded: 3, dormant: 97, starts, wake, resources,
    realElevenLabsCalls: 0, localProviderResponses: 15, maxConcurrentStarts: 4,
    automaticIdle, idleTimeoutMs, idleStops,
    checks: ["no eager Python engines", "authorization before wake", "8 requests one process",
      "stop confirms exit", "approved runs preserved", "corpus/report/profile preserved", "no paid replay", "private run reads"],
    cpuMax: readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim(), memoryMax: readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim() };
  writeFileSync(join(root, "on-demand-report.json"), JSON.stringify(report));
  console.log("REPORT " + JSON.stringify(report));
} finally { await ui.close(); }
