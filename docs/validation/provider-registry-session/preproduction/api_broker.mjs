// Trusted transport/controller. It never imports the candidate API application.
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createChannel, engineTiming, proxyHttpRequest } from './private_channel.mjs';
import { createFinancialPreflight } from './financial_preflight.mjs';

const configPath = process.argv[2];
const bytes = await readFile(configPath);
if (process.versions.node !== '22.23.4' || createHash('sha256').update(bytes).digest('hex') !== process.argv[3])
  throw new Error('Broker runtime or configuration changed before imports');
const config = JSON.parse(bytes);
if (config.host !== '127.0.0.1' || config.provider !== 'simulated') throw new Error('Local simulated API only');
const root = dirname(configPath);
const apiPid = Number(process.argv[4]);
if (!Number.isSafeInteger(apiPid) || apiPid < 1) throw new Error('Native API PID required');
const preflight = createFinancialPreflight(config, root, process.argv[3]);
await preflight();
await promisify(execFile)('docker', ['image', 'inspect', config.image], { timeout: 10000, windowsHide: true });
for (const workspace of config.workspaces) {
  const guard = JSON.parse(await readFile(join(workspace.engine.restoreGuardDir, 'guard.json'), 'utf8'));
  if (!['ready', 'quarantined'].includes(guard.state)) throw new Error('Unknown workspace restore state');
}
const { DockerMcpStdioTransport } = await import(pathToFileURL(config.brokerModule).href);
const { validateIsolatedWorkspaces } = await import(new URL('./calibration/supabase-auth.js', pathToFileURL(config.brokerModule)));
const registered = new Map(config.workspaces.map(workspace => [workspace.workspaceId, {
  workspace, transport: new DockerMcpStdioTransport({ ...workspace.engine, image: config.image }), started: false,
}]));
validateIsolatedWorkspaces({ host: config.host, jobQueue: config.jobQueue,
  workspaces: [...registered.values()].map(entry => ({ ...entry.workspace, mcpTransport: entry.transport })) });
const channel = createChannel(process.stdin, process.stdout);
const watchExit = entry => entry.transport.onExit(() => channel.event('engine.exit', { workspace: entry.workspace.workspaceId }));
for (const entry of registered.values()) watchExit(entry);
channel.events.on('fault', error => { console.error(error.message); process.exit(1); });
channel.handle(async (method, args) => {
  if (method === 'preflight') {
    if (args.workspace !== undefined && !registered.has(args.workspace)) throw new Error('Unknown workspace');
    await preflight(args.workspace); return { accepted: true };
  }
  if (method === 'auth') {
    const url = new URL(args.url);
    if (url.origin !== config.supabase.url || !['/auth/v1/user', '/rest/v1/calibration_workspaces'].includes(url.pathname)
        || (args.options.method ?? 'GET') !== 'GET') throw new Error('Auth route outside registered scope');
    const response = await fetch(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { apikey: config.supabase.publishableKey, authorization: args.options.headers.authorization ?? '' } });
    const body = await response.text();
    if (body.length > 2 ** 19) throw new Error('Auth response exceeds limit');
    return { status: response.status, headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' }, body };
  }
  if (method === 'credential') {
    const entry = registered.get(args.workspace);
    if (!entry || !entry.workspace.credentials?.env) throw new Error('Unregistered business credential source');
    const secret = entry.workspace.credentials.env.ELEVENLABS_API_KEY;
    if (secret !== undefined && typeof secret !== 'string') throw new Error('Invalid business credential');
    return { env: secret ? { ELEVENLABS_API_KEY: secret } : {} };
  }
  if (method !== 'engine') throw new Error('Unknown controller operation');
  const entry = registered.get(args.workspace);
  if (!entry) throw new Error('Unknown workspace');
  if (args.method === 'close') {
    if (!entry.started) return null;
    await entry.transport.close();
    entry.transport = new DockerMcpStdioTransport({ ...entry.workspace.engine, image: config.image });
    entry.started = false;
    watchExit(entry); return null;
  }
  try { await preflight(args.workspace); }
  catch (error) { error.emitted = false; throw error; }
  const secret = entry.workspace.credentials?.env?.ELEVENLABS_API_KEY ?? '';
  const { transportMs: timeout } = engineTiming(args.timeoutMs);
  if (args.method === 'schema') { entry.started = true; return entry.transport.schema(secret, timeout); }
  if (args.method === 'readCorpus') { entry.started = true; return entry.transport.readCorpus(secret, timeout); }
  if (args.method === 'callTool' && typeof args.name === 'string' && /^[a-z_]+$/.test(args.name)) {
    entry.started = true;
    return entry.transport.callTool(args.name, args.args, secret, timeout);
  }
  throw new Error('Unknown registered engine operation');
});
const frontend = http.createServer((req, res) => proxyHttpRequest(req, res, channel));
let ready = false;
channel.events.on('ready', message => { if (message.pid !== apiPid) process.exit(1); ready = true; });
const health = http.createServer(async (req, res) => {
  try {
    if (req.url !== '/healthz' || !ready) throw new Error('Not ready');
    await preflight();
    const registry = await promisify(execFile)(config.registryPython,
      ['-I', '-B', join(root, 'provider_registry_status.py'), configPath], { timeout: 10000, windowsHide: true });
    const providerRegistry = JSON.parse(registry.stdout);
    if (!providerRegistry.valid) throw new Error('Invalid provider registry');
    const auth = await fetch(config.supabase.url + '/auth/v1/health', {
      headers: { apikey: config.supabase.publishableKey }, signal: AbortSignal.timeout(10000), redirect: 'error' });
    if (!auth.ok) throw new Error('Auth dependency unavailable');
    await promisify(execFile)('docker', ['image', 'inspect', config.image], { timeout: 10000, windowsHide: true });
    const owner = JSON.parse(await readFile(join(config.jobQueue.dataDir, 'owner.lock'), 'utf8'));
    if (owner.pid !== apiPid) throw new Error('API queue owner differs from native PID');
    const anonymous = await fetch(`http://127.0.0.1:${config.apiPort}/api/bootstrap`);
    if (anonymous.status !== 401) throw new Error('Anonymous API admission failed');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'ready', provider: 'simulated', api: `http://127.0.0.1:${config.apiPort}`,
      pid: apiPid, proxyPid: process.pid, commit: config.commit, providerRegistry }));
  } catch { res.writeHead(503); res.end('not ready'); }
});
await Promise.all([new Promise(resolve => frontend.listen(config.apiPort, config.host, resolve)),
  new Promise(resolve => health.listen(config.healthPort, config.host, resolve))]);
const shutdown = async () => {
  clearInterval(timer); ready = false;
  channel.event('shutdown', {});
};
channel.events.on('stopped', async () => {
  frontend.closeAllConnections(); health.closeAllConnections();
  await Promise.all([new Promise(resolve => frontend.close(resolve)), new Promise(resolve => health.close(resolve))]);
  for (const entry of registered.values()) if (entry.started) await entry.transport.close();
  await unlink(join(root, 'stop.request')).catch(() => {}); process.exit(0);
});
channel.events.on('closed', () => process.exit(1));
const timer = setInterval(() => { if (existsSync(join(root, 'stop.request'))) shutdown().catch(() => process.exit(1)); }, 250);
await writeFile(join(root, 'runtime.json'), JSON.stringify({ pid: apiPid, proxyPid: process.pid }));
