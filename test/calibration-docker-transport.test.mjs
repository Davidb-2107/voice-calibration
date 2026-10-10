import { test } from 'node:test';
import { throws, rejects } from 'node:assert';
import { mkdtempSync, mkdirSync } from 'node:fs';
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
