import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCalibrationApplication } from '../dist/calibration/application.js';
import { startCalibrationUi } from '../dist/calibration/http-server.js';

const repositories = () => ({ runs: { list: async () => [], recoverRunning: async () => {} } });

test('only a published run with frozen real provenance can request a shared reference', async () => {
  const identity = 'v3:hmac-sha256:' + 'a'.repeat(64);
  const run = { id: 'real-run', workspaceId: 'tenant-a', status: 'succeeded', configurationIdentity: identity,
    executionProvider: undefined, request: { voiceRef: 'voice', params: {} } };
  let attachments = 0;
  const app = createCalibrationApplication({ providerMode: 'elevenlabs', configurationIdentity: identity,
    repositories: { ...repositories(), runs: { ...repositories().runs, get: async () => run },
      profiles: { list: async () => [{ sourceRunId: run.id, workspaceId: 'tenant-a' }] } }, canonical: {},
    bridge: { publishLiveProfile: async input => {
      attachments++; assert.deepEqual(input, { workspaceId: 'tenant-a', runId: run.id });
      return { profileId: 'stable-config' };
    } },
  });
  await assert.rejects(app.projectVoiceReference('tenant-a', run.id), /réel publié/);
  run.executionProvider = 'simulated';
  await assert.rejects(app.projectVoiceReference('tenant-a', run.id), /mode fournisseur modifié/);
  assert.equal(attachments, 0);
  run.executionProvider = 'elevenlabs';
  assert.deepEqual(await app.projectVoiceReference('tenant-a', run.id), {
    schema: 'project-voice-reference-v1', workspaceId: 'tenant-a', profileId: 'stable-config',
  });
  assert.equal(attachments, 1);
});

test('live catalog is restricted to real mode and to the resolved workspace', async () => {
  let reads = 0;
  const bridge = { getLiveProfiles: async workspaceId => { reads++; return { workspaceId, schema: 'live-voice-corpus-v1' }; } };
  for (const providerMode of ['simulated', undefined]) {
    const app = createCalibrationApplication({ providerMode, repositories: repositories(), bridge, canonical: {} });
    await assert.rejects(app.getLiveProfiles('tenant-a'), /simulé/);
    await assert.rejects(app.recordTikTokObservation('tenant-a', 'profile', {}), /simulées/);
  }
  assert.equal(reads, 0);
  const app = createCalibrationApplication({ providerMode: 'elevenlabs', repositories: repositories(), bridge, canonical: {} });
  assert.equal((await app.getLiveProfiles('tenant-a')).workspaceId, 'tenant-a');
  bridge.getLiveProfiles = async () => ({ workspaceId: 'tenant-b' });
  await assert.rejects(app.getLiveProfiles('tenant-a'), /workspace mismatch/);
});

test('observation routes require the session nonce and cannot override workspace authorization', async t => {
  const observations = [];
  let publications = 0;
  const api = await startCalibrationUi({ workspaceId: 'tenant-a', application: {
    getSessionNonce: () => 'nonce-a',
    getLiveProfiles: async workspace => ({ workspaceId: workspace, sessionNonce: 'nonce-a' }),
    recordTikTokObservation: async (workspace, profile, observation) => {
      observations.push({ workspace, profile, observation }); return { duplicate: observations.length > 1 };
    },
    projectVoiceReference: async (workspace, run) => { publications++; return { schema: 'project-voice-reference-v1', workspaceId: workspace, profileId: 'stable-profile' }; },
    close: async () => {},
  } });
  t.after(() => api.close());
  const url = api.url + '/api/v1/live-voice-profiles/' + encodeURIComponent('elevenlabs:voice:fr:cfg-abc') + '/observations';
  const send = (value, nonce = 'nonce-a') => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-calibration-nonce': nonce }, body: JSON.stringify(value) });
  assert.equal((await send({}, 'invalid')).status, 409);
  assert.equal((await send({ workspaceId: 'tenant-b' })).status, 400);
  assert.equal(observations.length, 0);
  assert.equal((await send({ workspaceId: 'tenant-a', measured: true })).status, 200);
  assert.equal(observations[0].workspace, 'tenant-a');
  assert.equal(observations[0].profile, 'elevenlabs:voice:fr:cfg-abc');
  const reference = await fetch(api.url + '/api/v1/calibration-runs/run-a/project-reference', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-calibration-nonce': 'nonce-a' }, body: '{}',
  });
  assert.equal(reference.status, 200);
  assert.equal((await reference.json()).profileId, 'stable-profile');
  assert.equal(publications, 1);
});

test('reading and recording observations only use corpus bridge calls, never an execution method', async () => {
  const calls = [];
  const app = createCalibrationApplication({ providerMode: 'elevenlabs', repositories: repositories(), canonical: {}, bridge: {
    execute: async () => { throw new Error('paid path forbidden'); },
    getLiveProfiles: async workspaceId => { calls.push('read'); return { workspaceId }; },
    recordTikTokObservation: async input => { calls.push(input); return { duplicate: true, revision: 'same' }; },
  } });
  await app.getLiveProfiles('tenant-a');
  assert.equal((await app.recordTikTokObservation('tenant-a', 'profile', { words: 200 })).duplicate, true);
  assert.deepEqual(calls, ['read', { workspaceId: 'tenant-a', profileId: 'profile', observation: { words: 200 } }]);
});
