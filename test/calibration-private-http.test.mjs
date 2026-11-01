import assert from 'node:assert/strict';
import test from 'node:test';
import { startSupabaseCalibrationApi } from '../dist/index.js';
import { DockerMcpStdioTransport } from '../dist/calibration/docker-transport.js';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('an authorized engine restart preserves the brokered transport', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'private-api-factory-'));
  mkdirSync(join(root, 'corpus'));
  let brokered = 0;
  t.mock.method(DockerMcpStdioTransport.prototype, 'schema', async () => { throw new Error('Unbrokered transport'); });
  class RemoteTransport extends DockerMcpStdioTransport {
    fork() { return new RemoteTransport(this.binding); }
    async schema() { brokered++; throw new Error('Brokered transport reached'); }
    async readCorpus() { return this.schema(); }
    async close() {}
  }
  const workspace = { tenantId: 'tenant-test', workspaceId: 'workspace-test', dataDir: join(root, 'ui'),
    stateDir: join(root, 'state'), wpmPath: join(root, 'corpus', 'wpm.json'),
    credentials: { env: { ELEVENLABS_API_KEY: 'synthetic-no-provider-call' } } };
  workspace.mcpTransport = new RemoteTransport({ ...workspace, root,
    image: `sha256:${'0'.repeat(64)}`, uiWorkspaceDir: join(workspace.dataDir, 'workspaces', workspace.workspaceId) });
  const supabase = { url: 'https://isolated-fixture.supabase.co', publishableKey: 'sb_publishable_fixture_only',
    fetch: async url => new URL(url).pathname === '/auth/v1/user'
      ? Response.json({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', role: 'authenticated',
        is_anonymous: false, email_confirmed_at: '2026-11-01T00:00:00Z' })
      : Response.json([{ id: 'workspace-test', tenant_id: 'tenant-test' }]) };
  const api = await startSupabaseCalibrationApi({ host: '127.0.0.1', port: 0, supabase, workspaces: [workspace] });
  try {
    await fetch(api.url + '/api/bootstrap', { headers: { authorization: 'Bearer synthetic-user' } });
    assert.equal(brokered, 1);
    // The failed first bootstrap closes that engine. A new authorized request
    // must create another brokered transport rather than reusing its failure.
    await fetch(api.url + '/api/bootstrap', { headers: { authorization: 'Bearer synthetic-user' } });
    assert.equal(brokered, 2);
  } finally { api.server.closeAllConnections(); await api.close(); }
});

test('private API creates the real HTTP handler without opening a network listener', async () => {
  const root = mkdtempSync(join(tmpdir(), 'private-api-handler-'));
  mkdirSync(join(root, 'corpus'));
  const workspace = { tenantId: 'tenant-test', workspaceId: 'workspace-test', dataDir: join(root, 'ui'),
    stateDir: join(root, 'state'), wpmPath: join(root, 'corpus', 'wpm.json'), credentials: { env: {} } };
  workspace.mcpTransport = new DockerMcpStdioTransport({ ...workspace, root,
    image: `sha256:${'0'.repeat(64)}`, uiWorkspaceDir: join(workspace.dataDir, 'workspaces', workspace.workspaceId) });
  const api = await startSupabaseCalibrationApi({
    host: '127.0.0.1', port: 0, deferListen: true, workspaces: [workspace],
    supabase: { url: 'https://isolated-fixture.supabase.co', publishableKey: 'sb_publishable_fixture_only',
      fetch: () => { throw new Error('Unexpected external Auth access'); } },
  });
  try { assert.equal(api.server.listening, false); }
  finally { await api.close(); }
});
