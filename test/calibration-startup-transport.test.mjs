import { test } from 'node:test';
import { deepStrictEqual, rejects, strictEqual } from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerMcpStdioTransport } from '../dist/calibration/docker-transport.js';
import { BridgeTransportError, createCalibrationBridge } from '../dist/calibration/bridge.js';

function fixture(t, { delay = 0, silent = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'engine-startup-'));
  const script = join(root, 'engine.mjs');
  writeFileSync(script, `
import { createInterface } from 'node:readline';
process.stderr.write('READY\\n');
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (!message.id || ${silent}) continue;
  const result = message.method === 'initialize' ? {} : { tools: [{ name: 'calibrate_voice', inputSchema: { type: 'object' } }] };
  process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n');
}
`);
  const transport = new DockerMcpStdioTransport({ root, tenantId: 'tenant-a', workspaceId: 'workspace-a',
    image: 'sha256:' + 'a'.repeat(64), wpmPath: join(root, 'corpus/wpm.json'),
    stateDir: join(root, 'state'), uiWorkspaceDir: join(root, 'ui') });
  transport.command = process.execPath;
  transport.args = [script];
  transport.startupTimeoutMs = 5000;
  let inspections = 0;
  let removals = 0;
  const created = Date.now();
  transport.inspectRunning = async () => { inspections++; return transport.stderrBuffer.includes('READY') && Date.now() - created >= delay; };
  transport.removeContainer = async () => { removals++; };
  t.after(async () => { await transport.close(); rmSync(root, { recursive: true, force: true }); });
  return { transport, inspections: () => inspections, removals: () => removals };
}

test('container startup has its own deadline before the MCP response deadline', async t => {
  const { transport, inspections } = fixture(t, { delay: 300 });
  deepStrictEqual(await transport.schema('fake-key', 200), { type: 'object' });
  strictEqual(inspections() > 1, true);
});

test('concurrent schema reads share one container startup and never call a business tool', async t => {
  const { transport } = fixture(t, { delay: 150 });
  const requests = [];
  const request = transport.request.bind(transport);
  transport.request = async (...args) => { requests.push(args[0]); return request(...args); };
  await Promise.all([transport.schema('fake-key', 1000), transport.schema('fake-key', 1000)]);
  strictEqual(requests.filter(name => name === 'initialize').length, 1);
  strictEqual(requests.includes('tools/call'), false);
});

test('startup failure is bounded, closes the child, and cannot restart it', async t => {
  const { transport, removals } = fixture(t, { delay: Infinity });
  transport.startupTimeoutMs = 150;
  await rejects(transport.schema('fake-key', 1000), error => error.code === 'ENGINE_STARTUP_TIMEOUT');
  strictEqual(transport.child, null);
  strictEqual(removals(), 1);
  await rejects(transport.schema('fake-key', 1000), /closing|startup/i);
});

test('running container with silent MCP still fails within the MCP deadline without execution', async t => {
  const { transport } = fixture(t, { delay: 150, silent: true });
  const request = transport.request.bind(transport);
  let initializeMs;
  transport.request = async (...args) => {
    const before = performance.now();
    try { return await request(...args); }
    finally { if (args[0] === 'initialize') initializeMs = performance.now() - before; }
  };
  const started = Date.now();
  await rejects(transport.schema('fake-key', 150), error => error.code === 'MCP_INITIALIZE_TIMEOUT');
  strictEqual(initializeMs >= 140 && initializeMs < 1150, true);
  strictEqual(Date.now() - started >= 300, true);
  strictEqual(Date.now() - started < 6000, true);
});

test('Docker inspection failure is terminal and cleanup runs once', async t => {
  const { transport, removals } = fixture(t);
  transport.inspectRunning = async () => { throw new Error('daemon unavailable with private details'); };
  await rejects(transport.schema('fake-key', 1000), error => error.code === 'ENGINE_STARTUP_FAILED' && !error.message.includes('private'));
  await rejects(transport.schema('fake-key', 1000), /startup closed/);
  await transport.close();
  strictEqual(removals(), 1);
});

test('close during startup cannot emit initialize or restart the child', async t => {
  const { transport } = fixture(t, { delay: Infinity });
  const methods = [];
  transport.request = async method => { methods.push(method); return {}; };
  const startup = transport.schema('fake-key', 1000);
  const failure = rejects(startup, error => error.code === 'ENGINE_STARTUP_FAILED');
  await new Promise(resolve => setTimeout(resolve, 50));
  await transport.close();
  await failure;
  deepStrictEqual(methods, []);
  await rejects(transport.schema('fake-key', 1000), /startup closed/);
});

test('bridge preserves startup error identity while redacting credentials', async () => {
  const secret = 'private-key-sentinel';
  const bridge = createCalibrationBridge({
    credentials: { status: async () => ({ configured: true }), forRun: async () => ({ provider: 'elevenlabs', secret }) },
    transport: {
      schema: async () => { throw new BridgeTransportError(`startup failed ${secret}`, false, secret, 'ENGINE_STARTUP_FAILED'); },
      call: async () => { throw new Error('business execution forbidden'); },
      close: async () => {},
    },
  });
  await rejects(bridge.getSchema(), error => error instanceof BridgeTransportError && error.code === 'ENGINE_STARTUP_FAILED'
    && !error.message.includes(secret) && !error.stderr.includes(secret) && error.emitted === false);
});

test('identity readiness uses ten seconds while business calls retain their configured timeout', async () => {
  const calls = [];
  const bridge = createCalibrationBridge({
    timeoutMs: 45_000, workspaceId: 'workspace-a', tenantId: 'tenant-a', stateDir: 'state-a',
    credentials: { status: async () => ({ configured: true }), forRun: async () => ({ provider: 'elevenlabs', secret: 'fake-key' }) },
    transport: {
      schema: async (_secret, timeout) => { calls.push(['schema', timeout]); return {}; },
      call: async () => { throw new Error('unexpected unnamed call'); },
      callTool: async (name, _args, _secret, timeout) => {
        calls.push([name, timeout]);
        return { response: name === 'get_server_info' ? { workspace_id: 'workspace-a', tenant_id: 'tenant-a', state_dir: 'state-a' }
          : { status: 'dry_run_success' }, emitted: true, stderr: '' };
      },
      close: async () => {},
    },
  });
  await bridge.getSchema();
  await bridge.dryRun({ runId: 'run-a', request: { voiceRef: 'voice-a', params: {}, postproc: 'cut' } });
  deepStrictEqual(calls, [['schema', 10_000], ['get_server_info', 10_000], ['calibrate_voice', 45_000]]);
});

for (const phase of ['schema', 'identity']) {
  test(`readiness classifies ${phase} response timeout without replay`, async () => {
    let businessCalls = 0;
    const timeout = () => { throw new BridgeTransportError('MCP request timed out', true, '', 'MCP_RESPONSE_TIMEOUT'); };
    const bridge = createCalibrationBridge({
      workspaceId: 'workspace-a', stateDir: 'state-a',
      credentials: { status: async () => ({ configured: true }), forRun: async () => ({ provider: 'elevenlabs', secret: 'fake-key' }) },
      transport: {
        schema: async () => phase === 'schema' ? timeout() : {},
        call: async () => { businessCalls++; throw new Error('business execution forbidden'); },
        callTool: async name => { strictEqual(name, 'get_server_info'); return timeout(); },
        close: async () => {},
      },
    });
    await rejects(bridge.getSchema(), error => error.code === 'MCP_READINESS_TIMEOUT');
    strictEqual(businessCalls, 0);
  });
}
