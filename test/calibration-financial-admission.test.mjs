import assert from 'node:assert/strict';
import { test } from 'node:test';

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
