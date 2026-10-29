import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createCalibrationApplication } from '../dist/calibration/application.js';
import { createCalibrationBridge, NodeMcpStdioTransport } from '../dist/calibration/bridge.js';
import { startCalibrationUi } from '../dist/calibration/http-server.js';
import { createSupabaseWorkspaceResolver } from '../dist/calibration/supabase-auth.js';

const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const member = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

test('authenticated HTTP to real MCP: explicit publication, member refusal, private metadata and revocation', {
  skip: !process.env.VOICE_CALIBRATION_TEST_PYTHON || !process.env.VOICE_CALIBRATION_TEST_MCP_ROOT,
}, async t => {
  const root = mkdtempSync(join(tmpdir(), 'reuse-mcp-fixture-'));
  const harness = join(process.env.VOICE_CALIBRATION_TEST_MCP_ROOT, 'tests/reusable_engine_fixture.py');
  const transport = new NodeMcpStdioTransport(process.env.VOICE_CALIBRATION_TEST_PYTHON, ['-B', harness, root]);
  t.after(async () => { await transport.close(); rmSync(root, { recursive: true, force: true }); });
  await transport.schema('inert-test-secret', 20000);
  const fixture = JSON.parse(readFileSync(join(root, 'fixture-ready.json'), 'utf8'));
  const credentials = { forRun: async () => ({ provider: 'elevenlabs', secret: 'inert-test-secret' }) };
  const bridge = createCalibrationBridge({ providerMode: 'elevenlabs', credentials, transport });
  const application = createCalibrationApplication({ providerMode: 'elevenlabs', bridge,
    repositories: { runs: { list: async () => [], recoverRunning: async () => {} } }, canonical: {} });
  // Only hosted Auth and RLS responses are synthetic; the resolver and engine authorizers run unchanged.
  const auth = { url: 'https://fixture.supabase.co', publishableKey: 'sb_publishable_fixture', fetch: async (url, options) => {
    const userId = options.headers.authorization === 'Bearer owner-token' ? owner :
      options.headers.authorization === 'Bearer member-token' ? member : null;
    if (!userId) return new Response('{}', { status: 401 });
    return Response.json(String(url).includes('/auth/v1/user') ? { id: userId, role: 'authenticated',
      email_confirmed_at: '2026-10-23T00:00:00Z' } : [{ id: fixture.scope.workspaceId, tenant_id: fixture.scope.tenantId }]);
  } };
  const api = await startCalibrationUi({ resolveApplication: createSupabaseWorkspaceResolver(auth,
    [{ tenantId: fixture.scope.tenantId, workspaceId: fixture.scope.workspaceId, application }]),
    closeApplications: async () => application.close() });
  t.after(() => api.close());
  const call = (path, { token = 'owner-token', body, nonce = application.getSessionNonce() } = {}) =>
    fetch(api.url + '/api/v1' + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-calibration-nonce': nonce },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const catalog = async token => {
    const response = await call('/reusable-voice-profiles', { token });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  assert.equal((await call('/reusable-voice-profiles', { token: 'invalid' })).status, 401);
  assert.deepEqual((await catalog('owner-token')).profiles, []);
  const sourcePaths = ['/live-voice-profiles', '/corpus', '/corpus/draft', '/voice-profiles',
    `/calibration-runs/${fixture.runId}`];
  for (const path of sourcePaths) assert.equal((await call(path)).status, 403, path);
  const publicBootstrap = await (await call('/bootstrap')).json();
  assert.deepEqual(publicBootstrap.recentRuns, []);
  assert.deepEqual(publicBootstrap.profiles, []);
  const publicationPath = `/calibration-runs/${fixture.runId}/reuse-publication`;
  assert.equal((await call(publicationPath, { token: 'member-token', body: {} })).status, 409);
  assert.deepEqual((await catalog('member-token')).profiles, []);
  assert.equal((await call(publicationPath, { body: { userId: owner } })).status, 400);
  assert.equal((await call(publicationPath, { body: {}, nonce: 'wrong' })).status, 409);
  const publication = await call(publicationPath, { body: {} });
  assert.equal(publication.status, 200, await publication.clone().text());
  const right = await publication.json();
  assert.equal(right.profileId, fixture.profileId);
  const launcherOutput = await new Promise((resolve, reject) => {
    const child = spawn(process.env.VOICE_CALIBRATION_TEST_PYTHON,
      ['-B', join(process.env.VOICE_CALIBRATION_TEST_MCP_ROOT, 'tests/reusable_launcher_fixture.py'), api.url, 'profiles'],
      { windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
  });
  assert.ok(launcherOutput.includes(right.profileId) && launcherOutput.includes(right.revision));
  for (const path of sourcePaths) assert.equal((await call(path)).status, 403, path);
  assert.equal((await call(`/live-voice-profiles/${encodeURIComponent(right.profileId)}/observations`, {
    body: { projectId: 'project-b', datasetId: 'dataset-b', profileId: right.profileId },
  })).status, 403);
  assert.deepEqual((await catalog('owner-token')).profiles, [right]);
  assert.deepEqual((await catalog('member-token')).profiles, []);
  assert.deepEqual(await (await call(publicationPath, { body: {} })).json(), right);
  const serialized = JSON.stringify(await catalog('owner-token'));
  for (const privateValue of ['observed_runs', '"audio"', fixture.corpus, fixture.runId, 'sourceRunId', 'canonicalRef'])
    assert.ok(!serialized.includes(privateValue), privateValue);
  assert.equal((await call(`/reusable-voice-profiles/${right.grantId}/corpus`)).status, 404);
  assert.equal((await call(`/reusable-voice-profiles/${right.grantId}/audio`)).status, 404);
  assert.equal((await call(`/reusable-voice-profiles/${right.grantId}/revoke`, { token: 'member-token', body: {} })).status, 409);
  assert.equal((await call('/reusable-voice-profiles?tenantId=foreign')).status, 400);
  const revoked = await call(`/reusable-voice-profiles/${right.grantId}/revoke`, { body: {} });
  assert.deepEqual(await revoked.json(), { grantId: right.grantId, version: 2, revoked: true });
  assert.deepEqual((await catalog('owner-token')).profiles, []);
  assert.equal((await call(publicationPath, { body: {} })).status, 409);
  assert.equal(createHash('sha256').update(readFileSync(fixture.corpus)).digest('hex'), fixture.sha256);
});

test('unauthenticated local mode cannot publish reuse rights', async t => {
  let calls = 0;
  const api = await startCalibrationUi({ workspaceId: 'workspace-a', application: {
    getSessionNonce: () => 'nonce', reusableProfiles: async () => { calls++; return {}; }, close: async () => {},
  } });
  t.after(() => api.close());
  assert.equal((await fetch(api.url + '/api/v1/reusable-voice-profiles')).status, 403);
  assert.equal(calls, 0);
});

test('engine metadata disclosure and identity mismatch fail closed at application boundary', async () => {
  const identity = { userId: owner, tenantId: 'tenant-a' };
  let value = { schema: 'reusable-voice-profiles-v1', workspaceId: 'workspace-a', ...identity, profiles: [] };
  const app = createCalibrationApplication({ providerMode: 'elevenlabs',
    repositories: { runs: { list: async () => [], recoverRunning: async () => {} } }, canonical: {},
    bridge: { reusableProfiles: async () => value } });
  value.workspaceId = 'foreign';
  await assert.rejects(app.reusableProfiles('workspace-a', identity, 'catalog'), /identity mismatch/);
  value.workspaceId = 'workspace-a';
  value.profiles = [{ observed_runs: [{ private: true }] }];
  await assert.rejects(app.reusableProfiles('workspace-a', identity, 'catalog'), /invalid reuse metadata/);
});

test('real legacy engine attests compatibility without gaining publication or reuse rights', {
  skip: !process.env.VOICE_CALIBRATION_TEST_PYTHON || !process.env.VOICE_CALIBRATION_TEST_MCP_ROOT,
}, async t => {
  const root = mkdtempSync(join(tmpdir(), 'reuse-legacy-mcp-'));
  const transport = new NodeMcpStdioTransport(process.env.VOICE_CALIBRATION_TEST_PYTHON,
    ['-B', join(process.env.VOICE_CALIBRATION_TEST_MCP_ROOT, 'tests/reusable_engine_fixture.py'), root, 'legacy']);
  t.after(async () => { await transport.close(); rmSync(root, { recursive: true, force: true }); });
  await transport.schema('inert-test-secret', 20000);
  const fixture = JSON.parse(readFileSync(join(root, 'fixture-ready.json'), 'utf8'));
  const bridge = createCalibrationBridge({ providerMode: 'elevenlabs', transport,
    credentials: { forRun: async () => ({ provider: 'elevenlabs', secret: 'inert-test-secret' }) } });
  const application = createCalibrationApplication({ providerMode: 'elevenlabs', bridge, canonical: {},
    repositories: { runs: { list: async () => [], recoverRunning: async () => {} } } });
  const auth = { url: 'https://fixture.supabase.co', publishableKey: 'sb_publishable_fixture',
    fetch: async url => Response.json(String(url).includes('/auth/v1/user') ? {
      id: owner, role: 'authenticated', email_confirmed_at: '2026-10-23T00:00:00Z',
    } : [{ id: fixture.scope.workspaceId, tenant_id: fixture.scope.tenantId }]) };
  let privateBootstraps = 0;
  application.getBootstrap = async () => { privateBootstraps++; return { recentRuns: ['legacy-visible'],
    profiles: [], activeCorpus: null, config: { configured: true }, sessionNonce: application.getSessionNonce() }; };
  const api = await startCalibrationUi({ resolveApplication: createSupabaseWorkspaceResolver(auth, [{
    tenantId: fixture.scope.tenantId, workspaceId: fixture.scope.workspaceId, application,
  }]), closeApplications: async () => application.close() });
  t.after(() => api.close());
  const call = (path, body) => fetch(api.url + '/api/v1' + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer owner-token',
      'content-type': 'application/json', 'x-calibration-nonce': application.getSessionNonce() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const corpus = await call('/live-voice-profiles');
  assert.equal(corpus.status, 200, await corpus.clone().text());
  assert.ok(Object.values((await corpus.json()).corpus).some(record => record.observed_runs.length > 0));
  assert.deepEqual((await (await call('/bootstrap')).json()).recentRuns, ['legacy-visible']);
  assert.equal(privateBootstraps, 1);
  assert.equal((await call('/reusable-voice-profiles')).status, 409);
  assert.equal((await call(`/calibration-runs/${fixture.runId}/reuse-publication`, {})).status, 409);
  assert.equal(createHash('sha256').update(readFileSync(fixture.corpus)).digest('hex'), fixture.sha256);
  await application.close();
  await assert.rejects(application.authorizeSourceRead(fixture.scope.workspaceId,
    { userId: owner, tenantId: fixture.scope.tenantId }, 'GET /api/v1/live-voice-profiles'));
});
