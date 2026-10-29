import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createCalibrationApplication } from '../dist/calibration/application.js';
import { createCalibrationBridge, NodeMcpStdioTransport } from '../dist/calibration/bridge.js';
import { startCalibrationUi } from '../dist/calibration/http-server.js';
import { createSupabaseWorkspaceResolver } from '../dist/calibration/supabase-auth.js';

const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const member = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');

test('launcher revokes reuse, recovers proved audio once and blocks uncertain audio', {
  skip: !process.env.VOICE_CALIBRATION_TEST_PYTHON || !process.env.VOICE_CALIBRATION_TEST_MCP_ROOT,
  timeout: 300000,
}, async t => {
  const root = mkdtempSync(join(tmpdir(), 'revocation-mcp-'));
  const engine = process.env.VOICE_CALIBRATION_TEST_MCP_ROOT;
  const vault = resolve(engine, '../..');
  const witnesses = new Map();
  for (const parent of [join(vault, 'Projects'), join(vault, 'Projects/TikTok')]) {
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const folder of ['_project', '_gate']) {
        const directory = join(parent, entry.name, folder);
        if (!existsSync(directory)) continue;
        for (const file of readdirSync(directory, { withFileTypes: true })) {
          if (file.isFile()) { const path = join(directory, file.name); witnesses.set(path, hash(path)); }
        }
      }
    }
  }
  assert.ok(witnesses.size >= 80);
  const transport = new NodeMcpStdioTransport(process.env.VOICE_CALIBRATION_TEST_PYTHON,
    ['-B', join(engine, 'tests/reusable_engine_fixture.py'), root, 'synthetic-production']);
  t.after(async () => { await transport.close(); rmSync(root, { recursive: true, force: true }); });
  await transport.schema('inert-test-secret', 20000);
  const fixture = JSON.parse(readFileSync(join(root, 'fixture-ready.json')));
  const bridge = createCalibrationBridge({ providerMode: 'elevenlabs', transport,
    credentials: { forRun: async () => ({ provider: 'elevenlabs', secret: 'inert-test-secret' }) } });
  const application = createCalibrationApplication({ providerMode: 'elevenlabs', bridge, canonical: {},
    repositories: { runs: { list: async () => [], recoverRunning: async () => {} } } });
  const auth = { url: 'https://fixture.supabase.co', publishableKey: 'sb_publishable_fixture', fetch: async (url, options) => {
    const userId = options.headers.authorization === 'Bearer owner-token' ? owner :
      options.headers.authorization === 'Bearer member-token' ? member : null;
    if (!userId) return new Response('{}', { status: 401 });
    return Response.json(String(url).includes('/auth/v1/user') ? { id: userId, role: 'authenticated',
      email_confirmed_at: '2026-10-26T00:00:00Z' } : [{ id: fixture.scope.workspaceId, tenant_id: fixture.scope.tenantId }]);
  } };
  const api = await startCalibrationUi({ resolveApplication: createSupabaseWorkspaceResolver(auth,
    [{ tenantId: fixture.scope.tenantId, workspaceId: fixture.scope.workspaceId, application }]),
    closeApplications: async () => application.close() });
  t.after(() => api.close());
  const post = (path, body, token = 'owner-token') => fetch(api.url + '/api/v1' + path, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
      'x-calibration-nonce': application.getSessionNonce() }, body: JSON.stringify(body) });
  const launch = args => new Promise((resolveResult, reject) => {
    const child = spawn(process.env.VOICE_CALIBRATION_TEST_PYTHON,
      ['-B', join(engine, 'tests/reusable_launcher_fixture.py'), api.url, '--vault-root', vault, ...args],
      { windowsHide: true, timeout: 60000, env: { ...process.env, VOICE_CALIBRATION_TEST_AUTHORITY: join(root, 'TEST-authority') } });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => resolveResult({ code, stdout, stderr }));
  });
  const ok = result => assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.equal((await post(`/calibration-runs/${fixture.runId}/reuse-publication`, {})).status, 200);
  const projects = ['Revocation A', 'Revocation B'].map(name => join(root, 'projects', name));
  for (const project of projects) {
    ok(await launch(['create', '--name', project.split(/[\\/]/).at(-1), '--root', join(root, 'projects'),
      '--project-type', 'preparation_fixture', '--slug', 'pilot', '--voice-profile', fixture.profileId]));
    writeFileSync(join(project, '_gate/gate_2_3.py'), 'raise SystemExit(0)\n');
    writeFileSync(join(project, 'outputs/01-pilot/narration.txt'), 'mot '.repeat(240).trim());
  }
  const bindings = projects.map(p => JSON.parse(readFileSync(join(p, '_project/calibration-connection.json'))).preparation);
  const voices = projects.map(p => JSON.parse(readFileSync(join(p, '_project/voice.json'))));
  const episodes = projects.map(p => join(p, 'outputs/01-pilot'));
  const corpora = bindings.map(b => join(root, 'state/prepared-projects', b.datasetId, 'voice_wpm.json'));
  const calls = () => JSON.parse(readFileSync(join(root, 'synthetic-provider-calls.json'))).length;
  const produce = index => launch(['produce', '--episode', episodes[index]]);
  const pending = index => JSON.parse(readFileSync(join(episodes[index], 'audio/project-production.json')));
  assert.equal((await post(`/reusable-voice-profiles/${voices[0].reuse_grant}/revoke`, {}, 'member-token')).status, 409);
  ok(await launch(['check', '--project-dir', projects[0]]));
  assert.equal((await produce(0)).code, 1, 'proved measurement response lost');
  assert.equal(calls(), 1);
  writeFileSync(join(root, 'synthetic-response-loss'), 'lose next synthetic response');
  assert.equal((await produce(1)).code, 1, 'uncertain emission has no proved audio');
  rmSync(join(root, 'synthetic-response-loss'));
  assert.equal(calls(), 2);
  for (const path of corpora) assert.deepEqual(JSON.parse(readFileSync(path)), {});
  const revocation = await launch(['revoke-profile', '--grant-id', voices[0].reuse_grant]);
  ok(revocation);
  assert.deepEqual(JSON.parse(revocation.stdout), { grantId: voices[0].reuse_grant, version: 2, revoked: true });
  ok(await launch(['revoke-profile', '--grant-id', voices[0].reuse_grant]));
  for (const project of projects) {
    const blocked = await launch(['check', '--project-dir', project]);
    assert.equal(blocked.code, 1);
    assert.match(blocked.stderr, /révoqué/);
    assert.equal((await launch(['predict', '--project-dir', project,
      '--narration', join(project, 'outputs/01-pilot/narration.txt')])).code, 1);
  }
  const voiceCall = body => post('/projects/voice', body);
  assert.equal((await voiceCall({ operation: 'produce', ...pending(0), binding: bindings[1] })).status, 409);
  assert.equal((await voiceCall({ operation: 'verify', ...pending(0) })).status, 409);
  assert.equal((await voiceCall({ operation: 'produce', ...pending(0), receiptId: '0'.repeat(32) })).status, 409);
  let lostAdmission = false;
  const prepare = bridge.prepareProject;
  try {
    bridge.prepareProject = async input => {
      const result = await prepare(input);
      if (input.operation === 'produce') { lostAdmission = true; throw new Error('lost admission response'); }
      return result;
    };
    assert.equal((await produce(0)).code, 1);
  } finally { bridge.prepareProject = prepare; }
  assert.equal(lostAdmission, true);
  const admitted = hash(corpora[0]);
  ok(await produce(0));
  ok(await produce(0));
  assert.equal(hash(corpora[0]), admitted);
  for (let attempt = 0; attempt < 2; attempt++) assert.equal((await produce(1)).code, 1);
  assert.equal(calls(), 2, 'neither recovery nor revoked requests can resynthesize');
  assert.deepEqual(JSON.parse(readFileSync(corpora[1])), {});
  const production = JSON.parse(readFileSync(join(episodes[0], 'audio.json')));
  assert.equal(production.observedRuns, 1);
  assert.equal(production.productionReady, false);
  assert.equal(hash(fixture.corpus), fixture.sha256);
  for (const [path, before] of witnesses) assert.equal(hash(path), before, path);
  const networkProof = JSON.parse(readFileSync(join(root, 'synthetic-network-proof.json')));
  assert.equal(networkProof.realProviderAttempts, 0);
  t.diagnostic(JSON.stringify({ ticket: '07', projects: bindings, syntheticCalls: calls(), networkProof,
    sourceUnchanged: true, existingFilesUnchanged: witnesses.size, observedRuns: [1, 0],
    revocationFromLauncher: true, cachedPredictionRefused: true, newEmissionRefused: true,
    provedRecoveryAfterRevocation: true, uncertainRecoveryRefused: true, crossProjectRefused: true,
    lostAdmissionResponseRecovered: lostAdmission, datasetAfterAdmission: admitted, datasetAfterReplay: hash(corpora[0]),
    productionReady: false }));
});
