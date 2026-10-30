import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('financial key is proposal-only; no client-provided authority or balance', async () => {
  const { validateFinancialRequest } = await import('../dist/calibration/financial-contract.js');
  validateFinancialRequest('propose', { financialOperationKey: 'request-1' });
  for (const key of ['', '../path', 'é', 'a\n', 'a'.repeat(129), true, null]) {
    assert.throws(() => validateFinancialRequest('propose', { financialOperationKey: key }));
  }
  assert.throws(() => validateFinancialRequest('execute', { financialOperationKey: 'request-1' }));
  assert.throws(() => validateFinancialRequest('propose', { financialOperationId: 'forged' }));
  assert.throws(() => validateFinancialRequest('propose', { financialAuthority: { verified: true } }));
});

test('financial result must have complete versioned opaque binding, with legacy unchanged', async () => {
  const { financialResultKeys } = await import('../dist/calibration/financial-contract.js');
  assert.deepEqual(financialResultKeys({}), []);
  assert.deepEqual(financialResultKeys({ financialSchema: 'internal-finance-v1', financialOperationId: '12345678-1234-4234-8234-123456789012' }), ['financialOperationId', 'financialSchema']);
  for (const result of [{ financialSchema: 'internal-finance-v1' }, { financialOperationId: 'forged' }, { financialSchema: 'v2', financialOperationId: '12345678-1234-4234-8234-123456789012' }]) {
    assert.throws(() => financialResultKeys(result));
  }
});

test('financial preflight refuses before any engine creation and is rerun on restart', async () => {
  const { EngineManager } = await import('../dist/calibration/engine-manager.js');
  let creates = 0;
  let allowed = false;
  const manager = new EngineManager([{ workspaceId: 'workspace-a', preflight: async () => {
    if (!allowed) throw new Error('financial target unattested');
  }, create: async () => { creates++; return { close: async () => {} }; } }]);
  try {
    await assert.rejects(manager.start('workspace-a'), /unattested/);
    assert.equal(creates, 0);
    allowed = true;
    await manager.start('workspace-a');
    assert.equal(creates, 1);
    allowed = false;
    await assert.rejects(manager.restart('workspace-a'), /unattested/);
    assert.equal(creates, 1);
  } finally { await manager.close(); }
});

for (const enabled of [true, false]) test(`financial proposal across actual HTTP/MCP, mode ${enabled}`, {
  skip: !process.env.VOICE_CALIBRATION_TEST_PYTHON || !process.env.VOICE_CALIBRATION_TEST_MCP_ROOT,
  timeout: 120000,
}, async t => {
  const { createCalibrationApplication } = await import('../dist/calibration/application.js');
  const { createCalibrationBridge, NodeMcpStdioTransport } = await import('../dist/calibration/bridge.js');
  const { createSupabaseWorkspaceResolver } = await import('../dist/calibration/supabase-auth.js');
  const { startCalibrationUi } = await import('../dist/calibration/http-server.js');
  const root = mkdtempSync(join(tmpdir(), 'p03-finance-mcp-'));
  const transport = new NodeMcpStdioTransport(process.env.VOICE_CALIBRATION_TEST_PYTHON,
    ['-B', join(process.env.VOICE_CALIBRATION_TEST_MCP_ROOT, 'tests/reusable_engine_fixture.py'), root, 'real-production', ...(enabled ? ['finance'] : [])]);
  t.after(async () => { await transport.close(); rmSync(root, { recursive: true, force: true }); });
  await transport.schema('inert-test-secret', 30000);
  const fixture = JSON.parse(readFileSync(join(root, 'fixture-ready.json')));
  const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const identity = { userId: owner, tenantId: fixture.scope.tenantId };
  const workspaceId = fixture.scope.workspaceId;
  const bridge = createCalibrationBridge({ providerMode: 'elevenlabs', transport,
    credentials: { forRun: async () => ({ provider: 'elevenlabs', secret: 'inert-test-secret' }) } });
  const application = createCalibrationApplication({ providerMode: 'elevenlabs', bridge, canonical: {},
    repositories: { runs: { list: async () => [], recoverRunning: async () => {} } } });
  const auth = { url: 'https://fixture.supabase.co', publishableKey: 'sb_publishable_fixture', fetch: async url =>
    Response.json(String(url).includes('/auth/v1/user') ? { id: owner, role: 'authenticated', email_confirmed_at: '2026-10-28T00:00:00Z' } : [{ id: workspaceId, tenant_id: identity.tenantId }]) };
  const api = await startCalibrationUi({ resolveApplication: createSupabaseWorkspaceResolver(auth,
    [{ tenantId: identity.tenantId, workspaceId, application }]), closeApplications: async () => application.close() });
  t.after(() => api.close());
  const profile = await application.reusableProfiles(workspaceId, identity, 'publish', fixture.runId);
  const { binding } = await application.prepareProject(workspaceId, identity, 'create', { name: 'P03 Pair' });
  const selected = await application.projectVoice(workspaceId, identity, 'select', { binding, profile });
  const text = 'mot '.repeat(240).trim();
  const prediction = await application.projectVoice(workspaceId, identity, 'predict', { binding, voice: selected.voice, text });
  const request = { binding, voice: selected.voice, text, receiptId: prediction.receiptId };
  const post = body => fetch(api.url + '/api/v1/projects/production', { method: 'POST',
    headers: { authorization: 'Bearer owner-token', 'content-type': 'application/json', 'x-calibration-nonce': application.getSessionNonce() }, body: JSON.stringify(body) });
  const firstResponse = await post({ action: 'propose', ...request, financialOperationKey: 'pair-1' });
  if (!enabled) {
    assert.equal(firstResponse.status, 409);
  } else {
    assert.equal(firstResponse.status, 200, await firstResponse.clone().text());
    const first = await firstResponse.json();
    assert.equal(first.financialSchema, 'internal-finance-v1');
    assert.match(first.financialOperationId, /^[a-f0-9-]{36}$/);
    assert.equal((await post({ action: 'approve', ...request, runId: first.runId, requestDigest: first.requestDigest, agreement: 'real' })).status, 200);
    const again = await (await post({ action: 'propose', ...request, financialOperationKey: 'pair-1' })).json();
    assert.equal(again.runId, first.runId);
    assert.equal(again.status, 'approved');
    const distinct = await (await post({ action: 'propose', ...request, financialOperationKey: 'pair-2' })).json();
    assert.notEqual(distinct.runId, first.runId);
    assert.equal(distinct.approval, null);
  }
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'real-mode-counters.json'))), {
    fakeProviderCalls: 0, realProviderAttempts: 0, withoutConsent: 0 });
});
