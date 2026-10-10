// Private Linux test process: production API/MCP/audio with fake Auth/provider.
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { EngineManager } from "/opt/node/dist/calibration/engine-manager.js";
import { CalibrationJobQueue } from "/opt/node/dist/calibration/job-queue.js";
import { NodeMcpStdioTransport } from "/opt/node/dist/calibration/bridge.js";
import { createVoiceCalibrationApplication } from "/opt/node/dist/calibration/entrypoint.js";
import { createSupabaseWorkspaceResolver, validateTenantWorkspaces } from "/opt/node/dist/calibration/supabase-auth.js";
import { startCalibrationUi } from "/opt/node/dist/calibration/http-server.js";

const root = "/data/benchmark";
const workspaces = validateTenantWorkspaces(Array.from({ length: 100 }, (_, index) => ({
  tenantId: `tenant-${index}`, workspaceId: `workspace-${index}`, dataDir: join(root, String(index), "ui"),
  stateDir: join(root, String(index), "state"), wpmPath: join(root, String(index), "corpus/voice_wpm.json"),
  credentials: { env: { ELEVENLABS_API_KEY: `benchmark-fake-${index}` } },
})));
const engines = new EngineManager(workspaces.map((options) => ({ workspaceId: options.workspaceId, async create() {
  const transport = new NodeMcpStdioTransport("/opt/venv/bin/python", ["/opt/fixtures/audio-benchmark-worker.py"], "/opt/fixtures",
    { ...options, uiWorkspaceDir: join(options.dataDir, "workspaces", options.workspaceId) });
  const app = await createVoiceCalibrationApplication({ ...options, mcpTransport: transport });
  process.send({ phase: "engine", workspaceId: options.workspaceId, pid: transport.child.pid });
  return app;
} })), { maxConcurrentStarts: 4, idleTimeoutMs: 1500 });
const queue = await CalibrationJobQueue.open("/data/jobs", 4);
const resolver = createSupabaseWorkspaceResolver({ url: "https://offline.supabase.co", publishableKey: "sb_publishable_offline_test",
  fetch: async (url, options) => {
    const match = /^Bearer user-(\d+)$/u.exec(options.headers.authorization);
    const index = match ? Number(match[1]) : -1;
    if (index < 0 || index >= 100) return Response.json({}, { status: 401 });
    if (new URL(url).pathname === "/auth/v1/user") return Response.json({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, role: "authenticated",
      is_anonymous: false, email_confirmed_at: "2026-10-10T00:00:00Z" });
    const revoked = JSON.parse(readFileSync("/data/revoked.json", "utf8"));
    return Response.json(revoked.includes(index) ? [] : [{ id: `workspace-${index}`, tenant_id: `tenant-${index}` }]);
  } }, workspaces.map(({ tenantId, workspaceId }) => ({ tenantId, workspaceId, application: async () => {
    await engines.start(workspaceId); return engines.application(workspaceId);
  } })));
const api = await startCalibrationUi({ resolveApplication: resolver, jobQueue: queue,
  closeApplications: () => queue.close(() => engines.close()) });
const requests = new Map();
api.server.on("request", (request, response) => {
  const key = `${Date.now()}-${Math.random()}`;
  requests.set(key, request.url);
  response.on("finish", () => requests.delete(key));
});
mkdirSync("/data", { recursive: true });
writeFileSync("/data/api-owner.json", JSON.stringify({ pid: process.pid }));
process.send({ phase: "ready", url: api.url });
process.on("message", async (message) => {
  if (message === "diagnostics") process.send({ phase: "diagnostics", requests: [...requests.values()],
    slots: [...engines.slots].filter(([, slot]) => slot.engine || slot.transition || slot.stopping)
      .map(([workspaceId, slot]) => ({ workspaceId, active: slot.active, blocked: slot.blocked,
        transition: !!slot.transition, stopping: !!slot.stopping })) });
  if (message === "close") {
    try { await api.close(); process.send({ phase: "closed" }); process.disconnect(); }
    catch (error) { console.error(error); process.exitCode = 1; process.disconnect(); }
  }
});
