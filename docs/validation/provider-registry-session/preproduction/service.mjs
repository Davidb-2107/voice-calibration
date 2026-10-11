import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (config.host !== '127.0.0.1' || config.provider !== 'simulated') throw new Error('Local simulated service only');
if (!config.recoveryDir || existsSync(join(config.recoveryDir, 'restore.lock')))
  throw new Error('Restore control required; incomplete restoration must be reconciled before startup');
for (const workspace of config.workspaces) {
  if (!workspace.engine.restoreGuardDir) throw new Error('Independent workspace restore guard required');
  const guard = JSON.parse(readFileSync(join(workspace.engine.restoreGuardDir, 'guard.json'), 'utf8'));
  if (guard.version !== 1 || guard.workspace_id !== workspace.workspaceId || !['ready', 'quarantined'].includes(guard.state))
    throw new Error('Invalid restore control');
  if (!config.providerRegistryRequired || !existsSync(join(workspace.engine.restoreGuardDir, 'provider-registry/provider.sqlite3'))
    || !existsSync(join(workspace.engine.restoreGuardDir, 'provider-registry.key')))
    throw new Error('Initialized independent provider registry required');
}
const guardedImage = await promisify(execFile)('docker', ['image', 'inspect', '--format',
  '{{index .Config.Labels "voice-calibration.local-patch"}}', config.image], { timeout: 10000 });
if (guardedImage.stdout.trim() !== 'provider-registry') throw new Error('Image with independent provider registry required');
const { startSupabaseCalibrationApi, DockerMcpStdioTransport } = await import(pathToFileURL(config.module));
const control = dirname(process.argv[2]);
const stopFile = join(control, 'stop.request');
if (existsSync(stopFile)) unlinkSync(stopFile);
const workspaces = config.workspaces.map(w => ({ ...w,
  mcpTransport: new DockerMcpStdioTransport({ ...w.engine, image: config.image }) }));
const api = await startSupabaseCalibrationApi({ host: config.host, port: config.apiPort,
  supabase: config.supabase, workspaces, jobQueue: config.jobQueue,
  maxConcurrentStarts: 4, idleTimeoutMs: 600000 });
let closing = false;
const health = createServer(async (request, response) => {
  if (request.url !== '/healthz') { response.writeHead(404).end(); return; }
  try {
    const anonymous = await fetch(api.url + '/api/v1/bootstrap', { signal: AbortSignal.timeout(5000) });
    const auth = await fetch(config.supabase.url + '/auth/v1/health', {
      headers: { apikey: config.supabase.publishableKey }, signal: AbortSignal.timeout(10000) });
    await promisify(execFile)('docker', ['image', 'inspect', config.image], { timeout: 10000 });
    const owner = JSON.parse(readFileSync(join(config.jobQueue.dataDir, 'owner.lock'), 'utf8'));
    const registryCheck = await promisify(execFile)(config.registryPython,
      [join(control, 'provider_registry_status.py'), process.argv[2]], { timeout: 10000 });
    const registry = JSON.parse(registryCheck.stdout);
    const executionReady = config.workspaces.every(workspace =>
      JSON.parse(readFileSync(join(workspace.engine.restoreGuardDir, 'guard.json'), 'utf8')).state === 'ready');
    const ok = !closing && anonymous.status === 401 && auth.ok && owner.pid === process.pid && registry.valid;
    response.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: ok ? 'ready' : 'unavailable', pid: process.pid,
      commit: config.commit, provider: config.provider, api: api.url, supabase: auth.ok, queueOwned: owner.pid === process.pid,
      execution: executionReady && registry.valid ? 'ready' : 'restore_quarantine', providerRegistry: registry,
      localPatch: config.localPatch }));
  } catch { response.writeHead(503).end('{"status":"unavailable"}'); }
});
await new Promise((resolve, reject) => { health.once('error', reject); health.listen(config.healthPort, config.host, resolve); });
writeFileSync(join(control, 'runtime.json'), JSON.stringify({ pid: process.pid, api: api.url,
  health: `http://${config.host}:${config.healthPort}/healthz`, commit: config.commit }));
async function stop() {
  if (closing) return;
  closing = true;
  clearInterval(timer);
  await api.close();
  await new Promise(resolve => health.close(resolve));
  if (existsSync(stopFile)) unlinkSync(stopFile);
}
const timer = setInterval(() => { if (existsSync(stopFile)) void stop().catch(() => process.exit(1)); }, 500);
process.on('SIGTERM', () => void stop().catch(() => process.exit(1)));
process.on('SIGINT', () => void stop().catch(() => process.exit(1)));
console.log(JSON.stringify({ status: 'ready', pid: process.pid, api: api.url, provider: 'simulated' }));
