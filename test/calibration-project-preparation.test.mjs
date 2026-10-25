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

test('application refuses foreign identity or nested private data in preparation metadata', async () => {
  const identity = { userId: owner, tenantId: 'test-tenant' };
  const binding = { schema: 'project-preparation-v1', state: 'preparation', name: 'New project',
    creationId: 'creation-a', projectId: 'project-a', datasetId: 'dataset-a', workspaceId: 'test-workspace', ...identity };
  let result = { binding, productionReady: false, voiceProfile: null, observedRuns: 0 };
  const app = createCalibrationApplication({ canonical: {},
    repositories: { runs: { list: async () => [], recoverRunning: async () => {} } },
    bridge: { prepareProject: async () => result } });
  assert.deepEqual((await app.prepareProject('test-workspace', identity, 'create', { name: binding.name })).binding, binding);
  result = { ...result, binding: { ...binding, datasetId: { observed_runs: ['private'] } } };
  await assert.rejects(app.prepareProject('test-workspace', identity, 'create', { name: binding.name }), /identity mismatch/);
  result = { ...result, binding: { ...binding, workspaceId: 'foreign' } };
  await assert.rejects(app.prepareProject('test-workspace', identity, 'create', { name: binding.name }), /identity mismatch/);
});

test('real launcher, authenticated HTTP, bridge and MCP create two private unselected preparations; production never reaches provider', {
  skip: !process.env.VOICE_CALIBRATION_TEST_PYTHON || !process.env.VOICE_CALIBRATION_TEST_MCP_ROOT,
}, async t => {
  const root = mkdtempSync(join(tmpdir(), 'preparation-mcp-'));
  const engine = process.env.VOICE_CALIBRATION_TEST_MCP_ROOT;
  const vault = resolve(engine, '../..');
  const witnesses = new Map();
  const witnessRoots = [];
  for (const parent of [join(vault, 'Projects'), join(vault, 'Projects/TikTok')]) {
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const project = join(parent, entry.name);
      if (!existsSync(join(project, '_project'))) continue;
      witnessRoots.push(project);
      for (const folder of ['_project', '_gate']) {
        if (!existsSync(join(project, folder))) continue;
        for (const file of readdirSync(join(project, folder), { withFileTypes: true })) {
          if (file.isFile()) {
            const path = join(project, folder, file.name);
            witnesses.set(path, hash(path));
          }
        }
      }
    }
  }
  for (const relative of ['Shared/episode-tools/build_episode.py', 'Shared/episode-tools/_test_dual_schema.py']) {
    const path = join(vault, relative);
    if (existsSync(path)) witnesses.set(path, hash(path));
  }
  assert.ok(witnessRoots.length >= 8, 'eight existing project witnesses must be available');
  const transport = new NodeMcpStdioTransport(process.env.VOICE_CALIBRATION_TEST_PYTHON,
    ['-B', join(engine, 'tests/reusable_engine_fixture.py'), root, 'preparation-cut']);
  t.after(async () => { await transport.close(); rmSync(root, { recursive: true, force: true }); });
  await transport.schema('inert-test-secret', 20000);
  const fixture = JSON.parse(readFileSync(join(root, 'fixture-ready.json'), 'utf8'));
  let synthesisCalls = 0;
  const callTool = transport.callTool.bind(transport);
  transport.callTool = (...args) => {
    if (['calibrate_voice', 'propose_calibration', 'approve_calibration', 'execute_calibration', 'publish_calibration',
      'record_tiktok_observation'].includes(args[0])) { synthesisCalls++; throw new Error('Provider boundary forbidden'); }
    return callTool(...args);
  };
  const bridge = createCalibrationBridge({ providerMode: 'elevenlabs', transport,
    credentials: { forRun: async () => ({ provider: 'elevenlabs', secret: 'inert-test-secret' }) } });
  const application = createCalibrationApplication({ providerMode: 'elevenlabs', bridge, canonical: {},
    repositories: { runs: { list: async () => [], recoverRunning: async () => {} } } });
  let revoked = false;
  const auth = { url: 'https://fixture.supabase.co', publishableKey: 'sb_publishable_fixture', fetch: async (url, options) => {
    const userId = options.headers.authorization === 'Bearer owner-token' ? owner :
      options.headers.authorization === 'Bearer member-token' ? member : null;
    if (!userId) return new Response('{}', { status: 401 });
    return Response.json(String(url).includes('/auth/v1/user') ? { id: userId, role: 'authenticated',
      email_confirmed_at: '2026-10-24T00:00:00Z' } : revoked ? [] :
      [{ id: fixture.scope.workspaceId, tenant_id: fixture.scope.tenantId }]);
  } };
  const api = await startCalibrationUi({ resolveApplication: createSupabaseWorkspaceResolver(auth,
    [{ tenantId: fixture.scope.tenantId, workspaceId: fixture.scope.workspaceId, application }]),
    closeApplications: async () => application.close() });
  t.after(() => api.close());
  const call = (body, { token = 'owner-token', nonce = application.getSessionNonce(), query = '' } = {}) =>
    fetch(api.url + '/api/v1/projects/preparation' + query, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-calibration-nonce': nonce },
      body: JSON.stringify(body) });
  const launch = (args, script = 'reusable_launcher_fixture.py', extraEnv = {}) => new Promise((resolveResult, reject) => {
    const child = spawn(process.env.VOICE_CALIBRATION_TEST_PYTHON,
      ['-B', join(engine, 'tests', script), api.url, '--vault-root', vault, ...args], { windowsHide: true,
        env: { ...process.env, VOICE_CALIBRATION_TEST_AUTHORITY: join(root, 'TEST-authority'), ...extraEnv } });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => resolveResult({ code, stdout, stderr }));
  });
  assert.equal((await call({ operation: 'create', name: 'No auth' }, { token: 'invalid' })).status, 401);
  assert.equal((await call({ operation: 'create', name: 'Bad nonce' }, { nonce: 'wrong' })).status, 409);
  for (const key of ['tenantId', 'workspaceId', 'userId', 'projectId', 'datasetId', 'path'])
    assert.equal((await call({ operation: 'create', name: 'Forged', [key]: 'foreign' })).status, 400);
  const create = (name, extra = []) => launch(['create', '--account', 'test', '--name', name, '--root', join(root, 'projects'),
    '--project-type', 'preparation_fixture', '--slug', 'pilot', ...extra]);
  const interruptedServer = await create('Server recovered');
  assert.equal(interruptedServer.code, 1);
  const operationsFolder = join(root, 'state/preparation-control/creation-operations');
  const operations = readdirSync(operationsFolder).filter(file => file.endsWith('.json'));
  assert.equal(operations.length, 1);
  const serverOperation = JSON.parse(readFileSync(join(operationsFolder, operations[0])));
  assert.equal(serverOperation.state, 'pending');
  assert.equal(existsSync(join(root, 'state/preparation-control/registry.json')), false);
  const serverResumed = await create('Server recovered');
  assert.equal(serverResumed.code, 0, serverResumed.stderr + serverResumed.stdout);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'projects/Server recovered/_project/calibration-connection.json'))).preparation,
    serverOperation.binding);
  assert.equal(JSON.parse(readFileSync(join(operationsFolder, operations[0]))).state, 'complete');
  const publication = await fetch(api.url + `/api/v1/calibration-runs/${fixture.runId}/reuse-publication`, {
    method: 'POST', headers: { authorization: 'Bearer owner-token', 'content-type': 'application/json',
      'x-calibration-nonce': application.getSessionNonce() }, body: '{}' });
  assert.equal(publication.status, 200, await publication.clone().text());
  const result = await launch(['--root', join(root, 'projects'), '--profile-id', fixture.profileId],
    'preparation_launcher_fixture.py');
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.equal(result.stdout.match(/\[PREPARATION\]/g)?.length, 2);
  assert.ok(!result.stdout.includes('[PASS]'));
  const projectA = join(root, 'projects/Project A');
  const projectB = join(root, 'projects/Project B');
  const a = JSON.parse(readFileSync(join(projectA, '_project/calibration-connection.json'))).preparation;
  const b = JSON.parse(readFileSync(join(projectB, '_project/calibration-connection.json'))).preparation;
  assert.notEqual(a.projectId, b.projectId);
  assert.notEqual(a.datasetId, b.datasetId);
  for (const project of [projectA, projectB]) {
    const voice = JSON.parse(readFileSync(join(project, '_project/voice.json')));
    assert.equal(voice.voice_profile, 'TODO');
    assert.equal(voice.voice_id, 'TODO');
    for (const args of [['produce', '--episode', join(project, 'outputs/01-pilot')],
      ['gate', '--episode', join(project, 'outputs/01-pilot')], ['check', '--project-dir', project]]) {
      const result = await launch(args);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /\[BLOCK\]/);
    }
  }
  const inspected = await call({ operation: 'inspect', binding: a });
  assert.equal(inspected.status, 200, await inspected.clone().text());
  assert.deepEqual(await inspected.json(), { binding: a, productionReady: false, voiceProfile: null, observedRuns: 0 });
  assert.equal((await call({ operation: 'inspect', binding: a }, { token: 'member-token' })).status, 409);
  for (const key of ['projectId', 'datasetId', 'creationId'])
    assert.equal((await call({ operation: 'inspect', binding: { ...a, [key]: b[key] } })).status, 409);
  assert.equal((await call({ operation: 'create', name: 'Project A' })).status, 409);
  const aBefore = hash(join(projectA, '_project/voice.json'));
  const resumed = await create('Project A');
  assert.equal(resumed.code, 0, resumed.stderr + resumed.stdout);
  assert.deepEqual(JSON.parse(readFileSync(join(projectA, '_project/calibration-connection.json'))).preparation, a);
  assert.equal(hash(join(projectA, '_project/voice.json')), aBefore);
  assert.equal((await create('../escape')).code, 1);
  const selectedCreation = await create('Selected', ['--voice-profile', fixture.profileId]);
  assert.equal(selectedCreation.code, 0, selectedCreation.stderr + selectedCreation.stdout);
  for (const boundary of ['intent', 'journal', 'registry', 'pin', 'reread', 'complete']) {
    const name = `Interrupted ${boundary}`;
    const args = ['create', '--account', 'test', '--name', name, '--root', join(root, 'projects'),
      '--project-type', 'preparation_fixture', '--slug', 'pilot'];
    const cut = await launch(args, 'reusable_launcher_fixture.py', { VOICE_CALIBRATION_TEST_CUT: boundary });
    assert.equal(cut.code, 1, boundary + cut.stderr);
    const connection = join(root, 'projects', name, '_project/calibration-connection.json');
    const saved = existsSync(connection) ? readFileSync(connection, 'utf8') : null;
    if (boundary === 'intent') assert.equal(existsSync(join(root, 'projects', name)), false);
    const intentFolder = join(root, 'TEST-authority/creation-intents');
    const intent = readdirSync(intentFolder).filter(file => file.endsWith('.json'))
      .map(file => JSON.parse(readFileSync(join(intentFolder, file))))
      .find(value => value.request.name === name).creation;
    const resumed = await launch(args);
    assert.equal(resumed.code, 0, boundary + resumed.stderr + resumed.stdout);
    if (saved !== null) assert.equal(readFileSync(connection, 'utf8'), saved);
    const inspected = await call({ operation: 'inspect', operationId: intent.operationId });
    assert.equal(inspected.status, 200);
    const receipt = await inspected.json();
    assert.deepEqual(receipt.creation, intent);
    assert.deepEqual(receipt.binding, JSON.parse(readFileSync(connection)).preparation);
  }
  const concurrent = await Promise.all([create('Concurrent'), create('Concurrent')]);
  for (const result of concurrent) assert.equal(result.code, 0, result.stderr + result.stdout);
  const control = JSON.parse(readFileSync(join(root, 'TEST-authority/registry.json')));
  assert.equal(control.generation, 12);
  assert.equal(control.projects.length, 11);
  assert.equal((await call({ operation: 'produce', binding: a })).status, 400);
  assert.equal((await call({ operation: 'inspect', binding: a }, { query: '?workspaceId=foreign' })).status, 400);
  const voiceCall = (body, { token = 'owner-token', nonce = application.getSessionNonce() } = {}) =>
    fetch(api.url + '/api/v1/projects/voice', { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-calibration-nonce': nonce },
      body: JSON.stringify(body) });
  const sourceForbidden = () => fetch(api.url + '/api/v1/live-voice-profiles', { headers: { authorization: 'Bearer owner-token' } });
  assert.equal((await sourceForbidden()).status, 403);
  for (const project of [projectA, projectB]) {
    const configured = await launch(['configure', '--project-dir', project, '--voice-profile', fixture.profileId]);
    assert.equal(configured.code, 0, configured.stderr + configured.stdout);
  }
  const voiceA = JSON.parse(readFileSync(join(projectA, '_project/voice.json')));
  const voiceB = JSON.parse(readFileSync(join(projectB, '_project/voice.json')));
  assert.deepEqual(voiceA, voiceB);
  const status = await launch(['check', '--project-dir', projectA]);
  assert.equal(status.code, 0, status.stderr + status.stdout);
  const readiness = JSON.parse(status.stdout);
  assert.equal(readiness.ready, true);
  assert.equal(readiness.productionReady, false);
  assert.equal(readiness.observedRuns, 0);
  assert.deepEqual(readiness.voice, voiceA);
  const projectTransport = bridge.prepareProject;
  for (const location of ['voice', 'configuration', 'source']) {
    try {
      bridge.prepareProject = async input => {
        const result = await projectTransport(input);
        const target = location === 'configuration' ? result.voice.configuration : result[location];
        target.observed_runs = ['private fixture data'];
        return result;
      };
      assert.equal((await voiceCall({ operation: 'readiness', binding: a, voice: voiceA })).status, 409);
    } finally { bridge.prepareProject = projectTransport; }
  }
  const text = 'une narration pour le projet ' .repeat(40);
  const narration = join(root, 'narration.txt');
  writeFileSync(narration, text);
  const predicted = await launch(['predict', '--project-dir', projectA, '--narration', narration]);
  assert.equal(predicted.code, 0, predicted.stderr + predicted.stdout);
  const prediction = JSON.parse(predicted.stdout);
  assert.equal(prediction.source.kind, 'published');
  assert.equal(prediction.source.revision, voiceA.profile_revision);
  assert.ok(prediction.seconds > 0);
  assert.equal(prediction.observedRuns, 0);
  assert.equal(JSON.stringify(prediction).includes('observed_runs'), false);
  const verify = { operation: 'verify', binding: a, voice: voiceA, text, receiptId: prediction.receiptId };
  assert.equal((await voiceCall(verify)).status, 200);
  assert.equal((await voiceCall({ ...verify, binding: b })).status, 409);
  assert.equal((await voiceCall({ ...verify, text: text + 'modifié' })).status, 409);
  assert.equal((await voiceCall(verify, { token: 'member-token' })).status, 409);
  assert.equal((await voiceCall(verify, { nonce: 'wrong' })).status, 409);
  assert.equal((await voiceCall(verify, { token: 'invalid' })).status, 401);
  for (const key of ['projectId', 'datasetId', 'creationId'])
    assert.equal((await voiceCall({ ...verify, binding: { ...a, [key]: b[key] } })).status, 409);
  const changedVoice = structuredClone(voiceA);
  changedVoice.configuration.voice_settings.stability = 0.2;
  assert.equal((await voiceCall({ ...verify, voice: changedVoice })).status, 409);
  assert.equal((await sourceForbidden()).status, 403);
  for (const binding of [a, b]) {
    const corpus = join(root, 'state/prepared-projects', binding.datasetId, 'voice_wpm.json');
    assert.deepEqual(JSON.parse(readFileSync(corpus)), {});
  }
  assert.equal((await launch(['produce', '--episode', join(projectA, 'outputs/01-pilot')])).code, 1);
  const defaultBefore = hash(join(projectA, '_project/voice.json'));
  const noChoice = await launch(['configure', '--project-dir', projectA]);
  assert.equal(noChoice.code, 1);
  assert.equal(hash(join(projectA, '_project/voice.json')), defaultBefore);
  const revokeReuse = await fetch(api.url + `/api/v1/reusable-voice-profiles/${voiceA.reuse_grant}/revoke`, {
    method: 'POST', headers: { authorization: 'Bearer owner-token', 'content-type': 'application/json',
      'x-calibration-nonce': application.getSessionNonce() }, body: '{}' });
  assert.equal(revokeReuse.status, 200);
  assert.equal((await voiceCall(verify)).status, 409);
  assert.equal((await launch(['check', '--project-dir', projectA])).code, 1);
  revoked = true;
  assert.equal((await call({ operation: 'inspect', binding: a })).status, 403);
  assert.equal((await call({ operation: 'create', name: 'Revoked' })).status, 403);
  assert.equal(synthesisCalls, 0);
  assert.equal(hash(fixture.corpus), fixture.sha256);
  for (const [path, before] of witnesses) assert.equal(hash(path), before, path);
  t.diagnostic(JSON.stringify({ ticket: '04', fixtureProvenance: 'synthetic offline CUT; no real catalogue attestation',
    prediction, defaultReread: true, sameVoiceCrossProjectReceiptRefused: true, sourceReadsRefused: true,
    projects: [a, b], observedRuns: [0, 0], synthesisCalls,
    recovery: { localIntent: true, firstServerDataset: serverOperation.binding,
      authorityBoundaries: ['journal', 'registry', 'pin', 'reread', 'complete'],
      projects: control.projects.length, generation: control.generation },
    sameSessionWithExplicitSelection: true, sourceBefore: fixture.sha256, sourceAfter: hash(fixture.corpus),
    witnesses: [...witnesses].map(([path, before]) => ({ path, before, after: hash(path) })) }));
});
