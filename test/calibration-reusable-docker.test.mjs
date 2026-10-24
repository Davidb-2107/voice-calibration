import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { DockerMcpStdioTransport } from '../dist/calibration/docker-transport.js';
import { createCalibrationBridge } from '../dist/calibration/bridge.js';
import { createCalibrationApplication } from '../dist/calibration/application.js';

test('native Docker source authority and private preparations survive restart without granting source-data access', {
  skip: !process.env.VOICE_CALIBRATION_TEST_ENGINE_IMAGE || !process.env.VOICE_CALIBRATION_TEST_MCP_ROOT,
}, async t => {
  const parent = mkdtempSync(join(tmpdir(), 'reuse-native-docker-'));
  let transport;
  t.after(async () => { if (transport) await transport.close(); rmSync(parent, { recursive: true, force: true }); });
  const root = join(parent, 'workspace'), guard = join(parent, 'independent');
  for (const folder of ['state', 'corpus', 'ui']) mkdirSync(join(root, folder), { recursive: true });
  for (const folder of ['dataset-control', 'provider-registry']) mkdirSync(join(guard, folder), { recursive: true });
  writeFileSync(join(root, 'corpus/voice_wpm.json'), '{}');
  const image = process.env.VOICE_CALIBRATION_TEST_ENGINE_IMAGE;
  const admission = { projectId: 'source-a', datasetId: 'source-a' };
  const values = { VOICE_CALIBRATION_STATE_DIR: '/workspace/state', VOICE_CALIBRATION_WORKSPACE_ID: 'test-workspace',
    VOICE_CALIBRATION_TENANT_ID: 'test-tenant', VOICE_WPM_PATH: '/workspace/corpus/voice_wpm.json',
    VOICE_CALIBRATION_UI_WORKSPACE_DIR: '/workspace/ui', VOICE_CALIBRATION_RESTORE_GUARD_PATH: '/restore-control/guard.json',
    VOICE_CALIBRATION_PROVIDER_REGISTRY_DIR: '/provider-registry',
    VOICE_CALIBRATION_PROVIDER_REGISTRY_KEY: '/restore-control/provider-registry.key',
    VOICE_CALIBRATION_DATASET_CONTROL_DIR: '/dataset-control', VOICE_CALIBRATION_DATASET_ADMISSION: JSON.stringify(admission) };
  const fixture = join(process.env.VOICE_CALIBRATION_TEST_MCP_ROOT, 'tests/reusable_docker_setup.py');
  await promisify(execFile)('docker', ['run', '--rm', '--network=none', '--read-only', '--user=10001:10001',
    '--cap-drop=ALL', '--security-opt=no-new-privileges', '--tmpfs=/tmp:rw,nosuid,nodev,size=64m,uid=10001,gid=10001',
    ...[[root, '/workspace'], [guard, '/restore-control'], [join(guard, 'dataset-control'), '/dataset-control'],
      [join(guard, 'provider-registry'), '/provider-registry'], [dirname(fixture), '/fixture,readonly']]
      .flatMap(([src, dst]) => ['--mount', `type=bind,src=${src},dst=${dst}`]),
    '--env', 'ELEVENLABS_API_KEY', ...Object.entries(values).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
    '--entrypoint', '/opt/venv/bin/python', image, '-I', '-B', '/fixture/reusable_docker_setup.py'],
    { windowsHide: true, timeout: 60000, env: { ...process.env, ELEVENLABS_API_KEY: 'inert-test-secret' } });
  const prepared = JSON.parse(readFileSync(join(root, 'fixture-ready.json'), 'utf8'));
  const options = { root, restoreGuardDir: guard, image, tenantId: 'test-tenant', workspaceId: 'test-workspace',
    wpmPath: join(root, 'corpus/voice_wpm.json'), stateDir: join(root, 'state'), uiWorkspaceDir: join(root, 'ui'),
    datasetAdmission: admission };
  const identity = { userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', tenantId: options.tenantId };
  async function launch() {
    transport = new DockerMcpStdioTransport(options);
    await transport.schema('inert-test-secret', 10000);
    return createCalibrationApplication({ providerMode: 'elevenlabs', canonical: {},
      repositories: { runs: { list: async () => [], recoverRunning: async () => {} } },
      bridge: createCalibrationBridge({ providerMode: 'elevenlabs', transport,
        credentials: { forRun: async () => ({ provider: 'elevenlabs', secret: 'inert-test-secret' }) } }) });
  }
  let app = await launch();
  const invoke = (operation, target = '') => app.reusableProfiles(options.workspaceId, identity, operation, target);
  assert.deepEqual((await invoke('catalog')).profiles, []);
  await assert.rejects(app.authorizeSourceRead(options.workspaceId, identity, 'GET /api/v1/live-voice-profiles'));
  const right = await invoke('publish', prepared.runId);
  assert.equal(right.profileId, prepared.profileId);
  assert.deepEqual((await invoke('catalog')).profiles, [right]);
  const a = await app.prepareProject(options.workspaceId, identity, 'create', { name: 'Docker A' });
  const b = await app.prepareProject(options.workspaceId, identity, 'create', { name: 'Docker B' });
  assert.notEqual(a.binding.datasetId, b.binding.datasetId);
  assert.equal(a.productionReady, false);
  await transport.close();
  app = await launch();
  assert.deepEqual(await app.prepareProject(options.workspaceId, identity, 'inspect', { binding: a.binding }), a);
  assert.deepEqual(await app.prepareProject(options.workspaceId, identity, 'inspect', { binding: b.binding }), b);
  await assert.rejects(app.prepareProject(options.workspaceId, identity, 'inspect', {
    binding: { ...a.binding, datasetId: b.binding.datasetId } }));
  assert.deepEqual((await invoke('catalog')).profiles, [right]);
  await assert.rejects(app.authorizeSourceRead(options.workspaceId, identity, 'GET /api/v1/live-voice-profiles'));
  assert.equal((await invoke('revoke', right.grantId)).revoked, true);
  assert.deepEqual((await invoke('catalog')).profiles, []);
  assert.equal(createHash('sha256').update(readFileSync(options.wpmPath)).digest('hex'), prepared.sha256);
});
