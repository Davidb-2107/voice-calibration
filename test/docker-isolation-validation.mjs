import { strictEqual, deepStrictEqual } from 'node:assert';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DockerMcpStdioTransport } from '../dist/calibration/docker-transport.js';
import { startSupabaseCalibrationApi } from '../dist/calibration/supabase-auth.js';

const exec = promisify(execFile);
let hosted;
if (process.argv.includes('--hosted')) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  hosted = JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
const token = (suffix) => hosted?.accounts.find(account => account.suffix === suffix).accessToken ?? `fixture-${suffix}`;
const workspaceId = (suffix) => `${hosted ? 'hosted-' : ''}workspace-${suffix}`;
const tenantId = (suffix) => `${hosted ? 'hosted-' : ''}tenant-${suffix}`;
const image = JSON.parse(readFileSync(resolve('../../temp/isolated-engine-context/image.json'), 'utf8')).image;
const root = mkdtempSync(resolve('temp-docker-isolation-'));
const transports = [];
const reports = [];
const options = (suffix) => {
  const privateRoot = join(root, suffix);
  for (const path of ['corpus', 'state', 'ui']) mkdirSync(join(privateRoot, path), { recursive: true });
  writeFileSync(join(privateRoot, 'corpus/wpm.json'), '{}');
  writeFileSync(join(privateRoot, `private-${suffix}.txt`), `sentinel-${suffix}`);
  copyFileSync('test/fixtures/docker-isolation-probe.py', join(privateRoot, 'probe.py'));
  return { root: privateRoot, image, tenantId: tenantId(suffix), workspaceId: workspaceId(suffix),
    wpmPath: join(privateRoot, 'corpus/wpm.json'), stateDir: join(privateRoot, 'state'), uiWorkspaceDir: join(privateRoot, 'ui/workspaces', workspaceId(suffix)) };
};
const a = options('a'), b = options('b');
const prior = process.env.SUPABASE_SERVICE_ROLE_KEY;
process.env.SUPABASE_SERVICE_ROLE_KEY = 'parent-only-sentinel';
try {
  for (const [suffix, config] of [['a', a], ['b', b]]) {
    const transport = new DockerMcpStdioTransport(config);
    transports.push(transport);
    const started = performance.now();
    await transport.schema(`provider-${suffix}-sentinel`, 10000);
    const startupMs = Math.round(performance.now() - started);
    const info = await transport.callTool('get_server_info', {}, `provider-${suffix}-sentinel`, 10000);
    strictEqual(info.toolError ?? false, false);
    const response = await exec('docker', ['exec', transport.containerName, '/opt/venv/bin/python', '-I', '/workspace/probe.py', suffix]);
    const report = JSON.parse(response.stdout);
    deepStrictEqual(report, { ownWrite: true, foreignVisible: false, parentSecret: false, ownCredential: true,
      uid: 10001, symlinkDenied: true, rootWriteDenied: true, egressDenied: true });
    const inspected = JSON.parse((await exec('docker', ['inspect', transport.containerName])).stdout)[0];
    strictEqual(inspected.HostConfig.NetworkMode, 'none');
    strictEqual(inspected.HostConfig.ReadonlyRootfs, true);
    deepStrictEqual(inspected.HostConfig.CapDrop, ['ALL']);
    strictEqual(inspected.Mounts.filter(m => m.Type === 'bind').length, 1);
    const idleSample = JSON.parse((await exec('docker', ['stats', '--no-stream', '--format',
      '{"memory":"{{.MemUsage}}","cpu":"{{.CPUPerc}}"}', transport.containerName])).stdout);
    reports.push({ suffix, ...report, network: 'none', readonlyRoot: true, privateBindOnly: true, startupMs, idleSample });
  }
  await exec('docker', ['kill', transports[0].containerName]);
  const survived = await transports[1].callTool('get_server_info', {}, 'provider-b-sentinel', 10000);
  strictEqual(survived.toolError ?? false, false);
  await transports[1].close();
  const restarted = new DockerMcpStdioTransport(b);
  transports.push(restarted);
  await restarted.schema('provider-b-sentinel', 10000);
  strictEqual(readFileSync(join(b.root, 'private-b.txt'), 'utf8'), 'own-write-ok');
  await restarted.close();
  await transports[0].close();
  const api = await startSupabaseCalibrationApi({
    supabase: hosted?.supabase ?? { url: 'https://isolation-test.supabase.co', publishableKey: 'sb_publishable_offline_fixture',
      fetch: async (url, request) => {
        const suffix = request.headers.authorization === 'Bearer fixture-a' ? 'a' : 'b';
        return Response.json(new URL(url).pathname === '/auth/v1/user'
          ? { id: `${suffix.repeat(8)}-${suffix.repeat(4)}-4${suffix.repeat(3)}-8${suffix.repeat(3)}-${suffix.repeat(12)}`,
            role: 'authenticated', email_confirmed_at: '2026-10-10T00:00:00Z' }
          : [{ id: `workspace-${suffix}`, tenant_id: `tenant-${suffix}` }]);
      } },
    workspaces: [a, b].map(config => ({ tenantId: config.tenantId, workspaceId: config.workspaceId,
      wpmPath: config.wpmPath, stateDir: config.stateDir, dataDir: join(config.root, 'ui'),
      credentials: { env: { ELEVENLABS_API_KEY: `provider-${config.workspaceId.slice(-1)}-sentinel` } },
      mcpTransport: new DockerMcpStdioTransport(config) })) });
  try {
    for (const suffix of ['a', 'b']) {
      async function call(path, method = 'GET', body, nonce, extra = {}) {
        const response = await fetch(`${api.url}/api/v1/${path}`, { method,
          headers: { authorization: `Bearer ${token(suffix)}`, 'content-type': 'application/json',
            ...(nonce ? { 'x-calibration-nonce': nonce } : {}), ...extra },
          ...(body ? { body: JSON.stringify(body) } : {}) });
        const data = await response.json();
        strictEqual(response.ok, true, JSON.stringify(data));
        return data;
      }
      const nonce = (await call('bootstrap')).sessionNonce;
      const draft = await call('corpus/draft');
      const text = 'Un texte de calibration gratuit pour vérifier le moteur isolé.';
      const saved = await call('corpus/draft', 'PUT', { ...draft, items: [{ id: 'probe', order: 0, text }] }, nonce,
        { 'if-match': String(draft.revision) });
      await call('corpus/versions', 'POST', { expectedRevision: saved.revision }, nonce);
      const run = await call('calibration-runs/dry-run', 'POST', { voiceRef: `AuditVoice${suffix}`, postproc: 'cut',
        params: { voice_id: 'AUDITVOICE000000000001', model_id: 'eleven_multilingual_v2', corpus_key: `AuditVoice${suffix}`,
          voice_settings: { stability: .65, similarity_boost: .75, style: 0, use_speaker_boost: true },
          text_source: { kind: 'inline', text }, mode: 'precision', language: 'fr', runs: 5 } }, nonce);
      strictEqual(run.status, 'dry_run_ready');
      strictEqual(run.approval ?? null, null);
      const other = suffix === 'a' ? 'b' : 'a';
      const denied = await fetch(`${api.url}/api/v1/calibration-runs/${run.id}`, {
        headers: { authorization: `Bearer ${token(other)}` } });
      strictEqual(denied.status, 404);
      strictEqual(Object.keys(JSON.parse(readFileSync((suffix === 'a' ? a : b).wpmPath, 'utf8'))).length, 0);
    }
  } finally { await api.close(); }
  const report = { status: 'PASS', reports, crashIsolation: 'PASS', restartPersistence: 'PASS',
    apiDockerDryRun: 'PASS', crossRunReads: '404 both directions', approval: 'none',
    authentication: hosted ? 'real hosted Supabase' : 'simulated Supabase', paidCalls: 0, image };
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: 'PASS', evidence: join(root, 'report.json'), paidCalls: 0 }));
} finally {
  if (prior === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY = prior;
  for (const transport of transports) await transport.close();
}
