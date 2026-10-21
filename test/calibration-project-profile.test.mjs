import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { projectProfilePackage } from '../dist/calibration/project-profile.js';
import { createCalibrationApplication } from '../dist/calibration/application.js';
import { startCalibrationUi } from '../dist/calibration/http-server.js';

function fixture() {
  const id = 'e681a94c-99a2-4566-a9a6-90fc80cf1132';
  const settings = { stability: 0.65, similarity_boost: 0.75, style: 0, use_speaker_boost: true };
  const run = { id, workspaceId: 'tenant-a', executionProvider: 'elevenlabs', status: 'succeeded',
    request: { voiceRef: 'CalibratedTestVoice01', postproc: 'cut', corpusVersionId: 'corpus-1',
      params: { language: 'fr', model_id: 'eleven_multilingual_v2', voice_settings: settings } } };
  const profile = { id, workspaceId: run.workspaceId, voiceRef: run.request.voiceRef,
    corpusVersionId: 'corpus-1', sourceRunId: id, wpmSnapshot: 204 };
  const record = { profile: { voice_id: run.request.voiceRef, model_id: 'eleven_multilingual_v2',
    voice_settings: { similarity_boost: 0.75, stability: 0.65, style: 0, use_speaker_boost: true } },
    observed_runs: Array.from({ length: 5 }, (_, index) => ({ slug: `sample-${index}`, source_run_id: id,
      language: 'fr', postproc: 'cut', verified: true, words: 170, duration_s: 50,
      wpm_actual: 204, date: '2026-10-21', note: '/private/path provider-secret', api_key: 'provider-secret' })) };
  return { run, profile, record };
}

test('published CUT export carries a complete project profile and only its own measured dataset', () => {
  const { run, profile, record } = fixture();
  record.observed_runs.push({ ...record.observed_runs[0], source_run_id: 'another-run' });
  const envelope = projectProfilePackage(run, profile, record);
  const packet = JSON.parse(envelope.payload);
  assert.equal(packet.profile.id, `elevenlabs:${run.request.voiceRef}:fr:calibration-${run.id}`);
  assert.equal(packet.corpus.observed_runs.length, 5);
  assert.equal(packet.profile.atempo, 1);
  assert.deepEqual(packet.profile.voice_settings, run.request.params.voice_settings);
  assert.equal(envelope.digest, `sha256:${createHash('sha256').update(envelope.payload).digest('hex')}`);
  assert(!JSON.stringify(packet).includes('provider-secret'));
  assert(!JSON.stringify(packet).includes('/private/path'));
});

test('simulated, unknown, unfinished, RAW or drifted profiles cannot become production packages', () => {
  for (const mutate of [
    ({ run }) => { run.executionProvider = 'simulated'; },
    ({ run }) => { delete run.executionProvider; },
    ({ run }) => { run.status = 'execution_unknown'; },
    ({ run }) => { run.request.postproc = 'raw'; },
    ({ record }) => { record.profile.model_id = 'other-model'; },
    ({ record }) => { record.profile.voice_settings.stability = 0.5; },
    ({ record }) => { record.observed_runs.forEach(row => row.verified = false); },
  ]) {
    const value = fixture(); mutate(value);
    assert.throws(() => projectProfilePackage(value.run, value.profile, value.record));
  }
});

test('export keeps omitted speed omitted and rejects unexpected sensitive settings', () => {
  const value = fixture();
  value.run.request.params.voice_settings.speed = null;
  const profile = JSON.parse(projectProfilePackage(value.run, value.profile, value.record).payload).profile;
  assert(!Object.hasOwn(profile.voice_settings, 'speed'));
  value.run.request.params.voice_settings.api_key = 'provider-secret';
  value.record.profile.voice_settings.api_key = 'provider-secret';
  assert.throws(() => projectProfilePackage(value.run, value.profile, value.record), /réglages effectifs/);
});

test('simulated or unspecified application mode blocks export before reading any project data', async () => {
  for (const providerMode of ['simulated', undefined]) {
    const app = createCalibrationApplication({ providerMode, repositories: {
      runs: { list: async () => [], recoverRunning: async () => {} },
    }, bridge: {}, canonical: {} });
    await assert.rejects(app.exportProjectVoice('tenant-a', 'profile-1'), /simulés/);
  }
});

test('a profile from another workspace is never exported', async () => {
  const app = createCalibrationApplication({ providerMode: 'elevenlabs', repositories: {
    runs: { list: async () => [], recoverRunning: async () => {} },
    profiles: { list: async workspace => { assert.equal(workspace, 'tenant-b'); return []; } },
  }, bridge: {}, canonical: {} });
  await assert.rejects(app.exportProjectVoice('tenant-b', 'profile-from-a'), /introuvable/);
});

test('application exports only a published run with frozen real-provider provenance', async () => {
  const { run, profile, record } = fixture();
  const identity = 'v3:hmac-sha256:' + 'a'.repeat(64);
  run.configurationIdentity = identity;
  run.reportId = null;
  const app = createCalibrationApplication({ providerMode: 'elevenlabs', configurationIdentity: identity,
    repositories: { profiles: { list: async () => [profile] },
      runs: { list: async () => [], recoverRunning: async () => {}, get: async () => run } }, bridge: {},
    canonical: { readPublishedRecord: async () => record,
      ensurePublished: async input => { assert.equal(input.wpm, 204); return { canonicalRef: 'private' }; } },
  });
  const payload = JSON.parse((await app.exportProjectVoice('tenant-a', run.id)).payload);
  assert.equal(payload.profile.voice_id, run.request.voiceRef);
  delete run.executionProvider;
  await assert.rejects(app.exportProjectVoice('tenant-a', run.id), /provenance réelle/);
  run.executionProvider = 'simulated';
  await assert.rejects(app.exportProjectVoice('tenant-a', run.id), /mode fournisseur modifié/);
});

test('export route is a scoped read with an attachment and no execution', async t => {
  const { run, profile, record } = fixture();
  let exports = 0;
  const api = await startCalibrationUi({ workspaceId: 'tenant-a', application: {
    exportProjectVoice: async (workspace, id) => {
      assert.equal(workspace, 'tenant-a'); assert.equal(id, run.id); exports++;
      return projectProfilePackage(run, profile, record);
    }, close: async () => {},
  } });
  t.after(() => api.close());
  const result = await fetch(`${api.url}/api/v1/voice-profiles/${run.id}/export`);
  assert.equal(result.status, 200);
  assert.match(result.headers.get('content-disposition'), /attachment/);
  assert.equal(JSON.parse((await result.json()).payload).source.runId, run.id);
  const denied = await fetch(`${api.url}/api/v1/voice-profiles/${run.id}/export?workspaceId=tenant-b`);
  assert.equal(denied.status, 400);
  assert.equal(exports, 1);
});

test('preparation freezes the server-owned provider mode in the persisted run', async () => {
  for (const providerMode of ['elevenlabs', 'simulated']) {
    let saved;
    const app = createCalibrationApplication({ providerMode,
      configurationIdentity: 'v3:hmac-sha256:' + 'a'.repeat(64),
      repositories: {
        runs: { list: async () => [], recoverRunning: async () => {}, get: async () => null,
          create: async run => { saved = structuredClone(run); } },
        corpus: { getActiveVersion: async () => ({ id: 'corpus-1', contentDigest: 'corpus-digest',
          items: [{ id: 'one', order: 0, text: 'Un texte de calibration.' }] }) },
        profiles: { list: async () => [] },
      },
      bridge: { getSchema: async () => ({}), dryRun: async () => ({ accepted: true, plan: [], raw: {} }) },
      canonical: {},
    });
    const run = await app.prepareDryRun({ workspaceId: 'tenant-a', voiceRef: 'Voice1', postproc: 'cut',
      params: { language: 'fr', model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.65 } } });
    assert.equal(run.executionProvider, providerMode);
    assert.equal(saved.executionProvider, providerMode);
  }
});

test('MCP projection preserves original provider provenance instead of inferring the current mode', async () => {
  const { run } = fixture();
  const identity = 'v3:hmac-sha256:' + 'a'.repeat(64);
  run.configurationIdentity = identity;
  run.requestDigest = 'v1:sha256:' + 'b'.repeat(64);
  run.reportId = null;
  run.proposal = { accepted: true, plan: [], raw: {} };
  let saved;
  const core = { runId: run.id, workspaceId: run.workspaceId, status: 'succeeded', revision: 2,
    request: { voice: run.request.voiceRef, ...run.request.params, postproc: 'cut' },
    requestDigest: run.requestDigest, context: {}, proposal: { plan: [] }, approval: null,
    result: {}, createdAt: '2026-10-21T00:00:00Z', updatedAt: '2026-10-21T00:00:00Z' };
  const app = createCalibrationApplication({ providerMode: 'elevenlabs', configurationIdentity: identity,
    repositories: { runs: { list: async () => [], recoverRunning: async () => {},
      get: async () => run, save: async value => { saved = value; } } },
    bridge: { getRun: async () => core }, canonical: {},
  });
  assert.equal((await app.getRun(run.workspaceId, run.id)).executionProvider, 'elevenlabs');
  assert.equal(saved.executionProvider, 'elevenlabs');
  delete run.executionProvider;
  assert.equal((await app.getRun(run.workspaceId, run.id)).executionProvider, undefined);
});

test('English publications keep the language-scoped synthesis profile', () => {
  const { run, profile, record } = fixture();
  run.request.params.language = 'en';
  record.profiles_by_lang = { en: record.profile };
  record.observed_runs.forEach(row => row.language = 'en');
  const payload = JSON.parse(projectProfilePackage(run, profile, record).payload);
  assert.equal(payload.profile.language, 'en');
  assert(payload.profile.id.includes(':en:calibration-'));
});
