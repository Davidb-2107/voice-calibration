import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCalibrationApplication } from '../dist/calibration/application.js';
function fixture() {
  return { run: { id: 'e681a94c-99a2-4566-a9a6-90fc80cf1132', workspaceId: 'tenant-a',
    executionProvider: 'elevenlabs', status: 'succeeded',
    request: { voiceRef: 'CalibratedTestVoice01', postproc: 'cut', corpusVersionId: 'corpus-1',
      params: { language: 'fr', model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.65, similarity_boost: 0.75, style: 0, use_speaker_boost: true } } } } };
}
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
