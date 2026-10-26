import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createCalibrationApplication } from '../dist/calibration/application.js';
import { createCalibrationBridge, NodeMcpStdioTransport } from '../dist/calibration/bridge.js';
import { startCalibrationUi } from '../dist/calibration/http-server.js';
import { createSupabaseWorkspaceResolver } from '../dist/calibration/supabase-auth.js';

const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const member = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const intent = { voice: 'missing-voice', voice_id: 'test-new-voice', model_id: 'eleven_multilingual_v2',
  voice_settings: { stability: 0.65, similarity_boost: 0.75, style: 0, use_speaker_boost: true },
  mode: 'precision', runs: 3, language: 'fr', postproc: 'cut',
  text_source: { kind: 'inline', text: 'une narration de calibrage '.repeat(30) } };

for (const mode of ['elevenlabs', 'simulated']) test(`launcher consent through authenticated HTTP/MCP, server mode ${mode}`, {
  skip: !process.env.VOICE_CALIBRATION_TEST_PYTHON || !process.env.VOICE_CALIBRATION_TEST_MCP_ROOT,
  timeout: 240000,
}, async t => {
  const root = mkdtempSync(join(tmpdir(), 'consent-mcp-'));
  const engine = process.env.VOICE_CALIBRATION_TEST_MCP_ROOT;
  const vault = resolve(engine, '../..');
  const witnesses = new Map();
  for (const parent of [join(vault, 'Projects'), join(vault, 'Projects/TikTok')]) {
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const folder of ['_project', '_gate']) {
        const directory = join(parent, entry.name, folder);
        if (!existsSync(directory)) continue;
        for (const file of readdirSync(directory, { withFileTypes: true })) {
          if (file.isFile()) { const path = join(directory, file.name); witnesses.set(path, hash(path)); }
        }
      }
    }
  }
  assert.ok(witnesses.size >= 80);
  const transport = new NodeMcpStdioTransport(process.env.VOICE_CALIBRATION_TEST_PYTHON,
    ['-B', join(engine, 'tests/reusable_engine_fixture.py'), root, 'consent']);
  t.after(async () => { await transport.close(); rmSync(root, { recursive: true, force: true }); });
  await transport.schema('inert-test-secret', 20000);
  const fixture = JSON.parse(readFileSync(join(root, 'fixture-ready.json')));
  const bridge = createCalibrationBridge({ providerMode: mode, transport,
    credentials: { forRun: async () => ({ provider: 'elevenlabs', secret: 'inert-test-secret' }) } });
  const application = createCalibrationApplication({ providerMode: mode, bridge, canonical: {},
    repositories: { runs: { list: async () => [], recoverRunning: async () => {} } } });
  const auth = { url: 'https://fixture.supabase.co', publishableKey: 'sb_publishable_fixture', fetch: async (url, options) => {
    const userId = options.headers.authorization === 'Bearer owner-token' ? owner :
      options.headers.authorization === 'Bearer member-token' ? member : null;
    if (!userId) return new Response('{}', { status: 401 });
    return Response.json(String(url).includes('/auth/v1/user') ? { id: userId, role: 'authenticated',
      email_confirmed_at: '2026-10-26T00:00:00Z' } : [{ id: fixture.scope.workspaceId, tenant_id: fixture.scope.tenantId }]);
  } };
  const api = await startCalibrationUi({ resolveApplication: createSupabaseWorkspaceResolver(auth,
    [{ tenantId: fixture.scope.tenantId, workspaceId: fixture.scope.workspaceId, application }]),
    closeApplications: async () => application.close() });
  t.after(() => api.close());
  const launch = args => new Promise((resolveResult, reject) => {
    const child = spawn(process.env.VOICE_CALIBRATION_TEST_PYTHON,
      ['-B', join(engine, 'tests/reusable_launcher_fixture.py'), api.url, '--vault-root', vault, ...args],
      { windowsHide: true, timeout: 60000, env: { ...process.env, VOICE_CALIBRATION_TEST_AUTHORITY: join(root, 'TEST-authority') } });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => resolveResult({ code, stdout, stderr }));
  });
  const parsed = result => {
    assert.equal(result.code, 0, result.stderr + result.stdout);
    return JSON.parse(result.stdout.trim().split('\n').at(-1));
  };
  const projects = [];
  for (const name of ['Consent A', 'Consent B']) {
    const created = await launch(['create', '--name', name, '--root', join(root, 'projects'),
      '--project-type', 'preparation_fixture', '--slug', 'pilot']);
    assert.equal(created.code, 0, created.stderr + created.stdout);
    projects.push(join(root, 'projects', name));
  }
  const [a, b] = projects.map(project => JSON.parse(readFileSync(join(project, '_project/calibration-connection.json'))).preparation);
  const defaults = projects.map(project => hash(join(project, '_project/voice.json')));
  const requestFile = join(root, 'request.json');
  writeFileSync(requestFile, JSON.stringify(intent));
  const calibrate = (action, run, extra = [], project = projects[0]) => launch(['calibrate', action,
    '--project-dir', project, '--request', requestFile,
    ...(run ? ['--run-id', run.runId, '--digest', run.requestDigest] : []), ...extra]);
  const call = (body, token = 'owner-token', nonce = application.getSessionNonce()) =>
    fetch(api.url + '/api/v1/projects/calibration', { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-calibration-nonce': nonce },
      body: JSON.stringify(body) });
  const counters = () => JSON.parse(readFileSync(join(root, 'consent-counters.json')));
  const run = parsed(await calibrate('propose'));
  assert.equal(run.providerMode, mode);
  assert.equal(run.approval, null);
  assert.match(run.warning, /Aucun appel payant ne sera lancé sans votre accord explicite/);
  assert.equal(run.snapshot.binding.datasetId, a.datasetId);
  assert.equal(run.productionReady, false);
  if (mode === 'elevenlabs') {
    const unavailable = await launch(['configure', '--project-dir', projects[0], '--voice-profile', 'unavailable']);
    assert.equal(unavailable.code, 1);
    assert.match(unavailable.stderr, /calibrate propose/);
    assert.match(unavailable.stderr, /Une synthèse réelle peut consommer des crédits/);
  } else assert.equal(run.estimate.estimated_credits, 0);
  for (const decision of ['refuse', 'cancel']) {
    const declined = parsed(await calibrate('propose'));
    const refused = await calibrate('approve', declined, ['--agreement', decision]);
    assert.equal(refused.code, 0, refused.stderr + refused.stdout);
    assert.match(refused.stdout, /\[REFUS\]/);
    assert.equal((await calibrate('execute', declined)).code, 1);
  }
  assert.equal((await calibrate('approve', run)).code, 1);
  assert.equal((await calibrate('execute', run)).code, 1);
  assert.equal(counters().fakeProviderCalls, 0);
  const payload = { binding: a, request: intent, runId: run.runId, requestDigest: run.requestDigest };
  for (const action of ['inspect', 'approve', 'execute', 'publish', 'reconcile']) {
    const body = { action, ...payload, ...(action === 'approve' ? { agreement: mode === 'simulated' ? 'simulation' : 'real' } : {}) };
    assert.equal((await call({ ...body, binding: b })).status, 409);
    assert.equal((await call(body, 'member-token')).status, 409);
  }
  assert.equal((await call({ action: 'inspect', ...payload }, 'invalid')).status, 401);
  assert.equal((await call({ action: 'inspect', ...payload }, 'owner-token', 'wrong')).status, 409);
  assert.equal((await call({ action: 'propose', binding: a, request: intent, providerMode: mode === 'simulated' ? 'elevenlabs' : 'simulated' })).status, 400);
  const agreement = mode === 'simulated' ? 'simulation' : 'real';
  const cancelled = parsed(await calibrate('propose'));
  parsed(await calibrate('approve', cancelled, ['--agreement', agreement]));
  assert.equal((await calibrate('approve', cancelled, ['--agreement', 'cancel'])).code, 0);
  assert.equal((await calibrate('execute', cancelled)).code, 1);
  const approved = parsed(await calibrate('approve', run, ['--agreement', agreement]));
  assert.equal(approved.approval.consumed_at, null);
  writeFileSync(requestFile, JSON.stringify({ ...intent, text_source: { kind: 'inline', text: 'texte différent' } }));
  assert.equal((await calibrate('execute', run)).code, 1);
  writeFileSync(requestFile, JSON.stringify(intent));
  const result = parsed(await calibrate('execute', run));
  assert.equal(result.status, 'succeeded');
  assert.ok(result.approval.consumed_at);
  assert.equal(result.result.simulated, mode === 'simulated');
  assert.equal(result.productionReady, false);
  assert.equal(counters().fakeProviderCalls, mode === 'simulated' ? 0 : 3);
  assert.equal((await calibrate('execute', run)).code, 1);
  assert.equal((await calibrate('publish', run)).code, 1);
  const expired = parsed(await calibrate('propose'));
  parsed(await calibrate('approve', expired, ['--agreement', agreement]));
  const gateRoot = join(root, 'state/preparation-control', a.datasetId, 'calibration-runs/workspaces/test-workspace/runs');
  const expiredPath = join(gateRoot, expired.runId + '.json');
  const stored = JSON.parse(readFileSync(expiredPath));
  stored.approval.expires_at = '2000-01-01T00:00:00Z';
  writeFileSync(expiredPath, JSON.stringify(stored));
  assert.equal((await calibrate('execute', expired)).code, 1);
  if (mode === 'elevenlabs') {
    const uncertain = parsed(await calibrate('propose'));
    parsed(await calibrate('approve', uncertain, ['--agreement', agreement]));
    writeFileSync(join(root, 'consent-uncertain'), 'fake lost response');
    assert.equal((await calibrate('execute', uncertain)).code, 1);
    assert.equal((await calibrate('execute', uncertain)).code, 1);
    assert.equal((await calibrate('propose')).code, 1);
    const diagnostic = await calibrate('reconcile', uncertain);
    assert.equal(diagnostic.code, 1);
    assert.match(diagnostic.stdout, /execution_unknown/);
    assert.match(diagnostic.stdout, /aucune réémission automatique/);
    assert.equal(counters().fakeProviderCalls, 4);
  }
  for (const [index, project] of projects.entries()) {
    assert.equal(hash(join(project, '_project/voice.json')), defaults[index]);
    const blocked = await launch(['produce', '--episode', join(project, 'outputs/01-pilot')]);
    assert.equal(blocked.code, 1);
    const binding = index ? b : a;
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'state/prepared-projects', binding.datasetId, 'voice_wpm.json'))), {});
  }
  assert.deepEqual(counters(), { fakeProviderCalls: mode === 'simulated' ? 0 : 4, realProviderAttempts: 0, withoutConsent: 0 });
  assert.equal(hash(fixture.corpus), fixture.sha256);
  for (const [path, before] of witnesses) assert.equal(hash(path), before, path);
  t.diagnostic(JSON.stringify({ ticket: '06', mode, provenance: 'isolated bench, synthetic Auth and provider',
    counters: counters(), productionReady: false, independentProjects: [a, b], witnessesUnchanged: witnesses.size,
    sourceUnchanged: hash(fixture.corpus) === fixture.sha256, refusal: true, cancellation: true,
    missingAgreement: true, modifiedIntentRefused: true, replayRefused: true, expiryRefused: true, crossProjectRefused: true }));
});
