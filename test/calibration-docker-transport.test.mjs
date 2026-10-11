import { test } from 'node:test';
import { throws, rejects } from 'node:assert';
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
