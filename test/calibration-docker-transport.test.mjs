import { test } from 'node:test';
import { throws, rejects, ok } from 'node:assert';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerMcpStdioTransport } from '../dist/calibration/docker-transport.js';
import { startSupabaseCalibrationApi } from '../dist/calibration/supabase-auth.js';

test('isolated transport rejects mutable images and paths outside the private root', () => {
  const root = mkdtempSync(join(tmpdir(), 'engine-guard-'));
  const options = { root, tenantId: 'tenant-a', workspaceId: 'workspace-a', image: 'latest',
    wpmPath: join(root, 'corpus/wpm.json'), stateDir: join(root, 'state'), uiWorkspaceDir: join(root, 'ui') };
  throws(() => new DockerMcpStdioTransport(options), /Immutable/);
  throws(() => new DockerMcpStdioTransport({ ...options, image: 'sha256:' + 'a'.repeat(64), stateDir: join(root, '../outside') }), /private root/);
  const immutable = { ...options, image: 'sha256:' + 'a'.repeat(64) };
  throws(() => new DockerMcpStdioTransport({ ...immutable, wpmPath: join(root, 'wpm.json') }), /private root/);
  throws(() => new DockerMcpStdioTransport({ ...immutable, stateDir: join(root, 'ui/state') }), /overlap protected UI/);
  throws(() => new DockerMcpStdioTransport({ ...immutable, wpmPath: join(root, 'ui/corpus/wpm.json') }), /overlap protected UI/);
  throws(() => new DockerMcpStdioTransport({ ...immutable, restoreGuardDir: join(root, 'restore') }), /outside the restored/);
  throws(() => new DockerMcpStdioTransport({ ...immutable, restoreGuardDir: join(root, '..') }), /outside the restored/);
});

test('isolated transport rejects a linked UI lock before starting Docker', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'engine-lock-guard-'));
  mkdirSync(join(root, 'ui'));
  const foreignLock = join(root, 'foreign.lock');
  writeFileSync(foreignLock, 'untouched');
  try { symlinkSync(foreignLock, join(root, 'ui/.instance.lock')); }
  catch (error) { if (error.code === 'EPERM') return t.skip('symlink privilege unavailable'); throw error; }
  const transport = new DockerMcpStdioTransport({ root, tenantId: 'tenant-a', workspaceId: 'workspace-a',
    image: 'sha256:' + 'a'.repeat(64), wpmPath: join(root, 'corpus/wpm.json'), stateDir: join(root, 'state'), uiWorkspaceDir: join(root, 'ui') });
  await rejects(transport.schema('unused', 1000), /symbolic links are not allowed/);
});

test('provider journal is writable while its signing key and restore guard remain read-only', () => {
  const parent = mkdtempSync(join(tmpdir(), 'provider-journal-mount-'));
  const root = join(parent, 'data');
  const guard = join(parent, 'recovery/workspace-a');
  const transport = new DockerMcpStdioTransport({ root, tenantId: 'tenant-a', workspaceId: 'workspace-a',
    image: 'sha256:' + 'a'.repeat(64), wpmPath: join(root, 'corpus/wpm.json'), stateDir: join(root, 'state'),
    uiWorkspaceDir: join(root, 'ui'), restoreGuardDir: guard });
  ok(transport.args.includes(`type=bind,src=${guard},dst=/restore-control,readonly`));
  ok(transport.args.includes(`type=bind,src=${join(guard, 'provider-registry')},dst=/provider-registry`));
  ok(transport.args.includes('VOICE_CALIBRATION_PROVIDER_REGISTRY_KEY=/restore-control/provider-registry.key'));
  ok(transport.args.includes('--network=none'));
});

test('scoped source transports dataset identity and independent writable control without changing legacy mounts', () => {
  const parent = mkdtempSync(join(tmpdir(), 'reuse-source-mount-'));
  const root = join(parent, 'data');
  const guard = join(parent, 'independent');
  const base = { root, tenantId: 'tenant-a', workspaceId: 'workspace-a', image: 'sha256:' + 'a'.repeat(64),
    wpmPath: join(root, 'corpus/wpm.json'), stateDir: join(root, 'state'), uiWorkspaceDir: join(root, 'ui') };
  const admission = { projectId: 'project-a', datasetId: 'dataset-a' };
  throws(() => new DockerMcpStdioTransport({ ...base, datasetAdmission: admission }), /independent restore/);
  throws(() => new DockerMcpStdioTransport({ ...base, restoreGuardDir: guard, datasetAdmission: null }), /independent restore/);
  const legacy = new DockerMcpStdioTransport({ ...base, restoreGuardDir: guard });
  ok(!legacy.args.some(value => value.startsWith('VOICE_CALIBRATION_DATASET_')));
  const scoped = new DockerMcpStdioTransport({ ...base, restoreGuardDir: guard, datasetAdmission: admission });
  admission.datasetId = 'tampered';
  ok(scoped.binding.datasetAdmission.datasetId === 'dataset-a');
  ok(scoped.args.includes('VOICE_CALIBRATION_DATASET_ADMISSION={"projectId":"project-a","datasetId":"dataset-a"}'));
  ok(scoped.args.includes('VOICE_CALIBRATION_DATASET_CONTROL_DIR=/dataset-control'));
  ok(scoped.args.includes(`type=bind,src=${join(guard, 'dataset-control')},dst=/dataset-control`));
  ok(scoped.args.includes(`type=bind,src=${guard},dst=/restore-control,readonly`));
});

test('public API refuses an unisolated engine before auth or provider IO', async () => {
  const root = mkdtempSync(join(tmpdir(), 'public-engine-guard-'));
  for (const path of ['ui', 'state', 'corpus']) mkdirSync(join(root, path));
  const options = {
    supabase: { url: 'https://test.supabase.co', publishableKey: 'unused' },
    workspaces: [{ tenantId: 'tenant-a', workspaceId: 'workspace-a', dataDir: join(root, 'ui'),
      stateDir: join(root, 'state'), wpmPath: join(root, 'corpus/wpm.json'), credentials: { env: {} } }] };
  await rejects(startSupabaseCalibrationApi(options), /isolated Docker/);
  await rejects(startSupabaseCalibrationApi({ ...options, publicOrigin: 'https://calibration.example',
    allowUnisolatedLocal: true }), /isolated Docker/);
});

for (const overlap of ['same', 'nested', 'foreign-data', 'queue']) {
  test(`API rejects provider recovery mount overlap: ${overlap}`, async () => {
    const parent = mkdtempSync(join(tmpdir(), 'provider-tenant-overlap-'));
    const guardA = join(parent, 'recovery/a');
    const guardB = overlap === 'same' ? guardA : overlap === 'nested' ? join(guardA, 'b') : join(parent, 'recovery/b');
    const workspaces = ['a', 'b'].map(id => {
      const root = join(parent, 'data', id);
      const workspaceId = `workspace-${id}`;
      const dataDir = join(root, 'ui');
      const stateDir = join(root, 'state');
      const wpmPath = join(root, 'corpus/wpm.json');
      const guard = id === 'a' && overlap === 'foreign-data' ? join(parent, 'data/b/recovery') : id === 'a' ? guardA : guardB;
      return { tenantId: `tenant-${id}`, workspaceId, dataDir, stateDir, wpmPath, credentials: { env: {} },
        mcpTransport: new DockerMcpStdioTransport({ root, tenantId: `tenant-${id}`, workspaceId,
          image: 'sha256:' + 'a'.repeat(64), stateDir, wpmPath, uiWorkspaceDir: join(dataDir, 'workspaces', workspaceId),
          restoreGuardDir: guard }) };
    });
    await rejects(startSupabaseCalibrationApi({ workspaces,
      supabase: { url: 'https://test.supabase.co', publishableKey: 'unused' },
      ...(overlap === 'queue' ? { jobQueue: { dataDir: guardA } } : {}) }), /overlaps/);
  });
}
