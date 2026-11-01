// Business API process: no registry/release signing key, Docker socket or network capability.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createChannel, engineTiming, attachHttpServer } from './private_channel.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await readFile(join(root, 'api-public.json'), 'utf8'));
const channel = createChannel(process.stdin, process.stdout);
channel.events.on('fault', error => { console.error(error.message); process.exit(1); });
await channel.request('preflight', {});
// The independent parent verified and locked this entire tree before this process existed.
const { DockerMcpStdioTransport, startSupabaseCalibrationApi } = await import(pathToFileURL(config.module).href);
const { BridgeTransportError } = await import(new URL('./calibration/bridge.js', pathToFileURL(config.module)));
class BrokeredTransport extends DockerMcpStdioTransport {
  constructor(workspace) {
    super({ ...workspace.engine, image: config.image }); this.workspace = workspace.workspaceId; this.registration = workspace;
  }
  fork() { return new BrokeredTransport(this.registration); }
  request(method, args = {}) {
    return channel.request('engine', { workspace: this.workspace, method, ...args }, engineTiming(args.timeoutMs).channelMs);
  }
  schema(secret, timeoutMs) { return this.request('schema', { timeoutMs }); }
  async callTool(name, args, secret, timeoutMs) {
    try { return await this.request('callTool', { name, args, timeoutMs }); }
    catch (error) { throw new BridgeTransportError(error.message, error.emitted !== false, error.stderr ?? '', error.code); }
  }
  call(args, secret, timeoutMs) { return this.callTool('calibrate_voice', args, secret, timeoutMs); }
  readCorpus(secret, timeoutMs) { return this.request('readCorpus', { timeoutMs }); }
  onExit(listener) {
    this.remoteExit = value => { if (value.workspace === this.workspace) listener(); };
    channel.events.on('engine.exit', this.remoteExit);
  }
  async close() {
    try { await this.request('close'); }
    finally { if (this.remoteExit) channel.events.off('engine.exit', this.remoteExit); }
  }
}
const supabase = { ...config.supabase, fetch: async (url, options) => {
  const result = await channel.request('auth', { url, options });
  return new Response(result.body, { status: result.status, headers: result.headers });
} };
const workspaces = [];
for (const workspace of config.workspaces) {
  // Preserve the existing business credential/HMAC contract. Signing keys are never brokered.
  const credentials = await channel.request('credential', { workspace: workspace.workspaceId });
  workspaces.push({ ...workspace, credentials, mcpTransport: new BrokeredTransport(workspace) });
}
const api = await startSupabaseCalibrationApi({
  host: '127.0.0.1', port: config.apiPort, deferListen: true, supabase,
  workspaces,
  jobQueue: config.jobQueue, providerMode: 'simulated', requireFinancialPreflight: true,
  financialPreflight: workspaceId => channel.request('preflight', { workspace: workspaceId }),
});
attachHttpServer(api.server, channel);
let stopping = false;
channel.events.on('shutdown', async () => {
  if (stopping) return;
  stopping = true; await api.close(); channel.event('stopped', {});
});
channel.events.on('closed', async () => { await api.close().catch(() => {}); process.exit(stopping ? 0 : 1); });
channel.event('ready', { pid: process.pid });
