// Opt-in development harness. Receives real sessions on stdin; never persists them.
import { strictEqual, deepStrictEqual, doesNotMatch } from 'node:assert';
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { startSupabaseCalibrationApi } from '../dist/calibration/supabase-auth.js';
import { NodeMcpStdioTransport } from '../dist/calibration/bridge.js';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const config = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const createWorkspaces = () => config.accounts.map((account) => {
  const root = join(config.runRoot, account.suffix);
  mkdirSync(root, { recursive: true });
  const wpmPath = join(root, 'corpus', 'voice_wpm.json');
  const stateDir = join(root, 'state');
  const dataDir = join(root, 'ui');
  strictEqual(existsSync(wpmPath), true, 'Preflight must register the test profile in a fresh private corpus');
  const workspaceId = `hosted-workspace-${account.suffix}`;
  const tenantId = `hosted-tenant-${account.suffix}`;
  const mcpTransport = new NodeMcpStdioTransport(config.python, [config.worker], config.pythonSource, {
    wpmPath, workspaceId, tenantId, stateDir, uiWorkspaceDir: join(dataDir, 'workspaces', workspaceId),
  });
  return { tenantId, workspaceId, wpmPath, stateDir, dataDir,
    credentials: { env: { ELEVENLABS_API_KEY: `hosted-test-fake-${account.suffix}` } }, mcpTransport };
});
const workspaces = createWorkspaces();
const queueOptions = config.queueMode ? { jobQueue: { dataDir: join(config.runRoot, 'queue'), maxConcurrentJobs: 1 } } : {};
let api = await startSupabaseCalibrationApi({ supabase: config.supabase, workspaces, ...queueOptions, allowUnisolatedLocal: true });
const checks = [];
const runIds = [];
const nonces = [];
function providerCalls(index) {
  const file = join(workspaces[index].stateDir, 'simulated-provider-calls.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).calls : 0;
}
async function call(index, path, method = 'GET', body, nonce, extra = {}) {
  const token = index === null ? null : config.accounts[index].accessToken;
  const response = await fetch(`${api.url}/api/v1/${path}`, { method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(nonce ? { 'x-calibration-nonce': nonce } : {}), ...extra },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  for (const account of config.accounts) strictEqual(text.includes(account.accessToken), false);
  doesNotMatch(text, /hosted-test-fake-/);
  return { status: response.status, body: JSON.parse(text) };
}
async function waitFor(check) {
  const deadline = Date.now() + 45_000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error('Hosted queue coordination timed out');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
async function publish(index) {
  const profile = await call(index, 'voice-profiles', 'POST', { runId: runIds[index] }, nonces[index]);
  strictEqual(profile.status, 201, JSON.stringify(profile.body));
  strictEqual(JSON.parse(readFileSync(workspaces[index].wpmPath, 'utf8')).HostedIsolationVoice.observed_runs.length, 5);
}
try {
  strictEqual((await call(null, 'bootstrap')).status, 401);
  checks.push('anonymous_block');
  for (const index of [0, 1]) {
    const bootstrap = await call(index, 'bootstrap');
    strictEqual(bootstrap.status, 200);
    deepStrictEqual(bootstrap.body.identity, { userId: config.accounts[index].userId,
      tenantId: workspaces[index].tenantId });
    nonces.push(bootstrap.body.sessionNonce);
    strictEqual(providerCalls(index), 0);
    strictEqual((await call(index, `corpus?workspaceId=${workspaces[1-index].workspaceId}`)).status, 400);
  }
  checks.push('real_auth_identity', 'foreign_workspace_block', 'no_provider_before_approval');
  for (const index of [0, 1]) {
    strictEqual((await call(index, 'corpus/draft', 'PUT', { items: [] }, nonces[1-index], { 'if-match': '0' })).status, 409);
    const draft = (await call(index, 'corpus/draft')).body;
    const saved = await call(index, 'corpus/draft', 'PUT', { ...draft,
      items: [{ id: 'narration', order: 0, text: `Ce texte appartient au workspace ${config.accounts[index].suffix}. `.repeat(26) }] },
      nonces[index], { 'if-match': String(draft.revision) });
    strictEqual(saved.status, 200);
    const publishedCorpus = await call(index, 'corpus/versions', 'POST', { expectedRevision: saved.body.revision }, nonces[index]);
    if (publishedCorpus.status !== 201) throw new Error(`corpus publication failed ${publishedCorpus.status}: ${JSON.stringify(publishedCorpus.body)}`);
    const voice = config.accounts[index].voiceConfig;
    const proposed = await call(index, 'calibration-runs/dry-run', 'POST', {
      voiceRef: voice.corpus.alias, postproc: 'cut', params: { voice_id: voice.voice_id,
        model_id: voice.model_id, corpus_key: voice.corpus.alias, voice_settings: voice.voice_settings,
        text_source: { kind: 'inline', text: 'ignored' }, mode: 'precision', language: 'fr', runs: 3, dry_run: false },
    }, nonces[index]);
    if (proposed.status !== 201) throw new Error(`dry-run failed ${proposed.status}: ${JSON.stringify(proposed.body)}`);
    runIds.push(proposed.body.id);
    strictEqual((await call(index, `calibration-runs/${proposed.body.id}/execute`, 'POST', {}, nonces[index])).status, 409);
    strictEqual(providerCalls(index), 0);
    const approved = await call(index, `calibration-runs/${proposed.body.id}/approve`, 'POST',
      { requestDigest: proposed.body.requestDigest }, nonces[index]);
    strictEqual(approved.status, 200);
    if (config.queueMode) continue;
    const completed = await call(index, `calibration-runs/${proposed.body.id}/execute`, 'POST', {}, nonces[index]);
    if (completed.status !== 200 || completed.body.status !== 'succeeded')
      throw new Error(`execution failed ${completed.status}: ${JSON.stringify(completed.body)}`);
    strictEqual(providerCalls(index), 5);
    const profile = await call(index, 'voice-profiles', 'POST', { runId: proposed.body.id }, nonces[index]);
    if (profile.status !== 201) throw new Error(`profile publication failed ${profile.status}: ${JSON.stringify(profile.body)}`);
    const corpus = JSON.parse(readFileSync(workspaces[index].wpmPath, 'utf8'));
    strictEqual(corpus.HostedIsolationVoice.observed_runs.length, 5);
    if (index === 0) strictEqual(JSON.parse(readFileSync(workspaces[1].wpmPath, 'utf8')).HostedIsolationVoice.observed_runs?.length ?? 0, 0);
  }
  if (config.queueMode) {
    const hold = join(workspaces[1].stateDir, 'queue-test-hold');
    writeFileSync(hold, 'test-only');
    strictEqual((await call(1, `calibration-runs/${runIds[1]}/enqueue`, 'POST', {}, nonces[1])).status, 202);
    await waitFor(async () => (await call(1, `calibration-runs/${runIds[1]}/job`)).body.status === 'running');
    strictEqual((await call(0, `calibration-runs/${runIds[0]}/enqueue`, 'POST', {}, nonces[0])).status, 202);
    strictEqual((await call(0, `calibration-runs/${runIds[0]}/enqueue`, 'POST', {}, nonces[0])).status, 202);
    strictEqual((await call(0, `calibration-runs/${runIds[0]}/job`)).body.status, 'queued');
    strictEqual((await call(1, `calibration-runs/${runIds[0]}/job`)).status, 404);
    strictEqual(providerCalls(0), 0);
    process.stdout.write(JSON.stringify({ phase: 'ready_for_revocation', userId: config.accounts[0].userId }) + '\n');
    await waitFor(() => existsSync(join(config.runRoot, 'membership-revoked')));
    unlinkSync(hold);
    await waitFor(async () => (await call(1, `calibration-runs/${runIds[1]}/job`)).body.status === 'finished');
    await waitFor(() => {
      const filename = createHash('sha256').update(JSON.stringify([workspaces[0].workspaceId, runIds[0]])).digest('hex') + '.json';
      return JSON.parse(readFileSync(join(config.runRoot, 'queue', filename), 'utf8')).status === 'awaiting_authentication';
    });
    strictEqual((await call(0, 'bootstrap')).status, 403);
    strictEqual(providerCalls(0), 0);
    await publish(1);
    process.stdout.write(JSON.stringify({ phase: 'ready_for_restoration', userId: config.accounts[0].userId }) + '\n');
    await waitFor(() => existsSync(join(config.runRoot, 'membership-restored')));
    strictEqual((await call(0, `calibration-runs/${runIds[0]}/job`)).body.status, 'awaiting_authentication');
    const completed = await call(0, `calibration-runs/${runIds[0]}/execute`, 'POST', {}, nonces[0]);
    strictEqual(completed.status, 200, JSON.stringify(completed.body));
    strictEqual(completed.body.status, 'succeeded');
    await publish(0);
    await api.close();
    api = await startSupabaseCalibrationApi({ supabase: config.supabase, workspaces: createWorkspaces(), ...queueOptions, allowUnisolatedLocal: true });
    for (const index of [0, 1]) {
      nonces[index] = (await call(index, 'bootstrap')).body.sessionNonce;
      strictEqual((await call(index, `calibration-runs/${runIds[index]}/job`)).body.status, 'finished');
      strictEqual((await call(index, `calibration-runs/${runIds[index]}/enqueue`, 'POST', {}, nonces[index])).status, 202);
      strictEqual(providerCalls(index), 5);
    }
    checks.push('hosted_queue_membership_revoked_before_dispatch', 'authenticated_resume', 'queue_restart_no_replay', 'queue_duplicate_no_spend');
    for (const name of readdirSync(join(config.runRoot, 'queue')).filter((name) => name.endsWith('.json'))) {
      const persisted = readFileSync(join(config.runRoot, 'queue', name), 'utf8');
      for (const account of config.accounts) strictEqual(persisted.includes(account.accessToken), false);
      doesNotMatch(persisted, /hosted-test-fake-/);
    }
    checks.push('durable_queue_contains_no_bearer_or_provider_secret');
  }
  checks.push('nonce_isolation', 'mandatory_consent', 'two_real_core_gates', 'simulated_execution_only', 'private_publication');
  for (const index of [0, 1]) {
    strictEqual((await call(index, `calibration-runs/${runIds[1-index]}`)).status, 404);
    strictEqual((await call(index, `calibration-runs/${runIds[1-index]}/execute`, 'POST', {}, nonces[index])).status, 404);
    const bootstrap = (await call(index, 'bootstrap')).body;
    strictEqual(bootstrap.recentRuns.length, 1);
    strictEqual(bootstrap.recentRuns[0].id, runIds[index]);
    strictEqual((await call(index, 'voice-profiles')).body.length, 1);
    strictEqual(providerCalls(index), 5);
  }
  checks.push('foreign_run_read_execute_block', 'private_run_and_profile_lists');
  // Parent revokes a DB membership, retaining the real access token for the next request.
  if (!config.queueMode) {
  process.stdout.write(JSON.stringify({ phase: 'ready_for_revocation', userId: config.accounts[0].userId }) + '\n');
  const marker = join(config.runRoot, 'membership-revoked');
  const deadline = Date.now() + 45_000;
  while (!existsSync(marker)) {
    if (Date.now() > deadline) throw new Error('Membership revocation coordination timed out');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  strictEqual((await call(0, 'bootstrap')).status, 403);
  strictEqual((await call(0, `calibration-runs/${runIds[0]}`)).status, 403);
  strictEqual((await call(1, 'bootstrap')).status, 200);
  strictEqual(providerCalls(0), 5);
  checks.push('real_membership_revocation_with_existing_token');
  }
  const report = { status: 'PASS', projectRef: config.projectRef, checks, runIds,
    queue: config.queueMode ? { storage: 'private-local-files', auth: 'hosted-supabase', maxConcurrentJobs: 1, apiRestart: 'graceful' } : null,
    membershipRestoration: 'pending-parent-verification',
    simulatedProviderCalls: workspaces.map((_, index) => providerCalls(index)), realElevenLabsCalls: 0,
    auth: 'hosted-real', databaseRls: 'hosted-real', calibrationProviderAndAudio: 'simulated' };
  writeFileSync(join(config.runRoot, 'report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report) + '\n');
} finally { await api.close(); }
