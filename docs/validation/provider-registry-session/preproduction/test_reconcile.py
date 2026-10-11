import json
from pathlib import Path
import pytest
from reconcile import audit, classify
from restore import restore, hashes

def run(status='approved', consumed=None, digest='request-a'):
    return {'workspace_id': 'a', 'run_id': 'run-a', 'request_digest': digest,
            'context': {'configuration_identity': 'bound-credentials-a'}, 'status': status,
            'approval': {'consumed_at': consumed}, 'result': {'status': 'ok'} if status == 'succeeded' else None}

@pytest.mark.parametrize(('evidence', 'decision'), [
    ([], 'no_independent_proof_keep_blocked'),
    ([{**run(), '_integrity': 'verified_at_restore'}], 'insufficient_independent_proof_keep_blocked'),
    ([{**run('succeeded', 'time'), '_integrity': 'legacy_without_capture_manifest'}], 'insufficient_independent_proof_keep_blocked'),
    ([{**run('succeeded', 'time'), '_integrity': 'verified_at_restore'}], 'success_record_preserved_do_not_replay'),
    ([{**run('execution_unknown', 'time'), '_integrity': 'verified_at_restore'}], 'approval_claimed_outcome_unknown_keep_blocked'),
    ([{**run('succeeded', 'time', 'foreign'), '_integrity': 'verified_at_restore'}], 'identity_conflict_keep_blocked'),
])
def test_evidence_decisions_never_authorize_retry(evidence, decision):
    assert classify(run(), evidence) == decision

def test_captured_evidence_is_checked_and_tampering_stays_blocked(tmp_path):
    data, backup, recovery = [tmp_path / name for name in ('data', 'backup', 'recovery')]
    path = 'a/state/gate/workspaces/a/runs/run-a.json'
    for root, value in ((data, run('succeeded', 'time')), (backup, run())):
        file = root / path
        file.parent.mkdir(parents=True)
        file.write_text(json.dumps(value))
    config = {'jobQueue': {'dataDir': str(data / 'queue')}, 'recoveryDir': str(recovery),
        'workspaces': [{'workspaceId': 'a', 'stateDir': str(data / 'a/state'), 'engine': {'restoreGuardDir': str(recovery / 'a')}}]}
    restored = restore(config, backup, hashes(backup))
    guard_before = (recovery / 'a/guard.json').read_bytes()
    before = hashes(data)
    result = audit(config)
    assert result['runs'][0]['decision'] == 'success_record_preserved_do_not_replay'
    assert result['runs'][0]['execution_allowed'] is False
    assert hashes(data) == before and (recovery / 'a/guard.json').read_bytes() == guard_before
    (Path(restored['previous_data']) / path).write_text(json.dumps(run()))
    result = audit(config)
    assert result['runs'][0]['execution_allowed'] is False
    assert result['runs'][0]['decision'] == 'no_independent_proof_keep_blocked'
    assert result['issues'][0]['reason'] == 'independent_evidence_invalid'
