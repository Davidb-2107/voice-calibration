// Destructive access is exercised only against disposable, nonsecret sentinels.
import { strictEqual } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeMcpStdioTransport } from '../dist/calibration/bridge.js';

const self = fileURLToPath(import.meta.url);
if (process.argv[2] === '--child') {
  const root = process.argv[3];
  const sibling = join(root, 'b', 'corpus-sentinel.txt');
  const read = readFileSync(sibling, 'utf8') === 'private-b-sentinel';
  writeFileSync(sibling, 'modified-by-a-sentinel');
  writeFileSync(join(root, 'result.json'), JSON.stringify({ siblingReadAllowed: read,
    siblingWriteAllowed: true, parentSecretInherited: process.env.SUPABASE_SERVICE_ROLE_KEY === 'audit-parent-sentinel',
    dedicatedProviderInjected: process.env.ELEVENLABS_API_KEY === 'audit-a-sentinel',
    workspaceBound: process.env.VOICE_CALIBRATION_WORKSPACE_ID === 'audit-a',
    uid: process.getuid?.() ?? null, platform: process.platform }, null, 2));
} else {
  const root = mkdtempSync(resolve('temp-system-isolation-'));
  for (const suffix of ['a', 'b']) mkdirSync(join(root, suffix));
  writeFileSync(join(root, 'b', 'corpus-sentinel.txt'), 'private-b-sentinel');
  const prior = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'audit-parent-sentinel';
  const transport = new NodeMcpStdioTransport(process.execPath, [self, '--child', root], undefined,
    { tenantId: 'audit-tenant-a', workspaceId: 'audit-a', stateDir: join(root, 'a'), wpmPath: join(root, 'a', 'voice_wpm.json') });
  if (prior === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY = prior;
  try { await transport.schema('audit-a-sentinel', 5000); } catch { /* Probe deliberately exits without MCP handshake. */ }
  finally { await transport.close(); }
  const report = JSON.parse(readFileSync(join(root, 'result.json'), 'utf8'));
  strictEqual(report.workspaceBound, true);
  strictEqual(report.dedicatedProviderInjected, true);
  strictEqual(report.parentSecretInherited, false);
  strictEqual(readFileSync(join(root, 'b', 'corpus-sentinel.txt'), 'utf8'), 'modified-by-a-sentinel');
  console.log(JSON.stringify({ ...report, evidence: join(root, 'result.json'), systemIsolation: 'FAIL' }));
}
