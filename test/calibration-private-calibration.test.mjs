import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createCalibrationApplication } from '../dist/calibration/application.js';
import { createCalibrationBridge, NodeMcpStdioTransport } from '../dist/calibration/bridge.js';
import { startCalibrationUi } from '../dist/calibration/http-server.js';
import { createSupabaseWorkspaceResolver } from '../dist/calibration/supabase-auth.js';

const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');

test('private voice metadata refuses a different run, a shared origin or mixed rights', async () => {
  const binding = { userId: owner, tenantId: 'tenant-a', workspaceId: 'workspace-a', projectId: 'private-a', datasetId: 'dataset-a', name: 'Private A' };
  const voice = { _schema: 'voice-profile-v1', name: 'Private', voice_profile: 'elevenlabs:private:fr:cfg',
    calibration_run: '11111111-1111-4111-8111-111111111111', calibration_workspace: binding.workspaceId,
    profile_revision: 'sha256:' + 'a'.repeat(64), atempo: 1, corpus: { alias: 'private', language: 'fr', style: '' },
    configuration: { provider: 'elevenlabs', voice_id: 'private', model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.65 },
      language: 'fr', postproc: 'cut', atempo: 1, cut_protocol: 'shared-audio-tools-cut-v1' } };
  const original = { binding, voice, ready: true, productionReady: false, observedRuns: 3,
    source: { kind: 'project', revision: voice.profile_revision }, datasetRevision: 'sha256:' + 'b'.repeat(64) };
  let response = original;
  const application = createCalibrationApplication({ providerMode: 'elevenlabs', canonical: {},
    bridge: { prepareProject: async () => structuredClone(response), close: async () => {} },
    repositories: { runs: { list: async () => [], recoverRunning: async () => {} } } });
  try {
    const call = () => application.projectVoice(binding.workspaceId, { userId: owner, tenantId: binding.tenantId }, 'readiness', { binding, voice });
    assert.deepEqual(await call(), original);
    for (const fault of ['run', 'origin', 'hybrid']) {
      response = structuredClone(original);
      if (fault === 'run') response.voice.calibration_run = '22222222-2222-4222-8222-222222222222';
      else if (fault === 'origin') response.source.kind = 'published';
      else Object.assign(response.voice, { reuse_grant: 'reuse_' + 'c'.repeat(64), reuse_version: 1 });
      await assert.rejects(call(), /Invalid project voice metadata/);
    }
  } finally { await application.close(); }
});

test('private calibration publish -> explicit launcher selection -> prediction, fake provider only', {
  skip: !process.env.VOICE_CALIBRATION_TEST_PYTHON || !process.env.VOICE_CALIBRATION_TEST_MCP_ROOT,
  timeout: 240000,
}, async t => {
  const root = mkdtempSync(join(tmpdir(), 'private-calibration-'));
  const engine = process.env.VOICE_CALIBRATION_TEST_MCP_ROOT;
  const vault = resolve(engine, '../..');
  const transport = new NodeMcpStdioTransport(process.env.VOICE_CALIBRATION_TEST_PYTHON,
    ['-B', join(engine, 'tests/reusable_engine_fixture.py'), root, 'private-calibration']);
  t.after(async () => { await transport.close(); rmSync(root, { recursive: true, force: true }); });
  await transport.schema('inert-test-secret', 20000);
  const fixture = JSON.parse(readFileSync(join(root, 'fixture-ready.json')));
  const bridge = createCalibrationBridge({ providerMode: 'elevenlabs', transport,
    credentials: { forRun: async () => ({ provider: 'elevenlabs', secret: 'inert-test-secret' }) } });
  const application = createCalibrationApplication({ providerMode: 'elevenlabs', bridge, canonical: {},
    repositories: { runs: { list: async () => [], recoverRunning: async () => {} } } });
  const auth = { url: 'https://fixture.supabase.co', publishableKey: 'sb_publishable_fixture', fetch: async url =>
    Response.json(String(url).includes('/auth/v1/user') ? { id: owner, role: 'authenticated',
      email_confirmed_at: '2026-10-26T00:00:00Z' } : [{ id: fixture.scope.workspaceId, tenant_id: fixture.scope.tenantId }]) };
  const api = await startCalibrationUi({ resolveApplication: createSupabaseWorkspaceResolver(auth,
    [{ tenantId: fixture.scope.tenantId, workspaceId: fixture.scope.workspaceId, application }]),
    closeApplications: async () => application.close() });
  t.after(async () => api.close());
  const launch = args => new Promise((done, reject) => {
    const child = spawn(process.env.VOICE_CALIBRATION_TEST_PYTHON,
      ['-B', join(engine, 'tests/reusable_launcher_fixture.py'), api.url, '--vault-root', vault, ...args],
      { windowsHide: true, timeout: 60000, env: { ...process.env, VOICE_CALIBRATION_TEST_AUTHORITY: join(root, 'TEST-authority') } });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => done({ code, stdout, stderr }));
  });
  const ok = result => { assert.equal(result.code, 0, result.stderr + result.stdout); return result; };
  const parsed = result => JSON.parse(ok(result).stdout.trim().split('\n').at(-1));
  const projects = [];
  for (const name of ['Private A', 'Private B']) {
    ok(await launch(['create', '--name', name, '--root', join(root, 'projects'), '--project-type', 'preparation_fixture', '--slug', 'pilot']));
    projects.push(join(root, 'projects', name));
  }
  const before = projects.map(project => hash(join(project, '_project/voice.json')));
  const request = join(root, 'request.json');
  writeFileSync(request, JSON.stringify({ voice: 'missing-private', voice_id: 'new-private-voice',
    model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.65, similarity_boost: 0.75 },
    mode: 'precision', runs: 3, language: 'fr', postproc: 'cut', text_source: { kind: 'inline', text: 'une narration de calibrage '.repeat(30) } }));
  const calibrate = (action, run, extra = []) => launch(['calibrate', action, '--project-dir', projects[0],
    '--request', request, ...(run ? ['--run-id', run.runId, '--digest', run.requestDigest] : []), ...extra]);
  const select = (project, run) => launch(['calibrate', 'select', '--project-dir', project, '--run-id', run.runId, '--digest', run.requestDigest]);
  const run = parsed(await calibrate('propose'));
  parsed(await calibrate('approve', run, ['--agreement', 'real']));
  parsed(await calibrate('execute', run));
  assert.equal((await select(projects[0], run)).code, 1);
  parsed(await calibrate('publish', run));
  assert.equal(hash(join(projects[0], '_project/voice.json')), before[0], 'Publication must not choose implicitly');
  assert.equal((await select(projects[1], run)).code, 1);
  ok(await select(projects[0], run));
  const voice = JSON.parse(readFileSync(join(projects[0], '_project/voice.json')));
  assert.equal(voice.calibration_run, run.runId);
  assert.equal(Object.hasOwn(voice, 'reuse_grant'), false);
  parsed(await calibrate('publish', run));
  ok(await select(projects[0], run));
  assert.equal(parsed(await launch(['check', '--project-dir', projects[0]])).source.kind, 'project');
  const narration = join(root, 'narration.txt');
  writeFileSync(narration, 'mot '.repeat(125));
  assert.ok(parsed(await launch(['predict', '--project-dir', projects[0], '--narration', narration])).seconds > 0);
  assert.equal(hash(join(projects[1], '_project/voice.json')), before[1]);
  assert.equal(hash(fixture.corpus), fixture.sha256);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'consent-counters.json'))),
    { fakeProviderCalls: 3, realProviderAttempts: 0, withoutConsent: 0 });
});
