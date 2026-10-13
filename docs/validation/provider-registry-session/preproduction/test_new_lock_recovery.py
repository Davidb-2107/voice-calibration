import json
from pathlib import Path

import pytest

import recover_owner as recovery


@pytest.fixture
def config(tmp_path, monkeypatch):
    queue = tmp_path / 'queue'
    store = tmp_path / 'workspace' / 'ui'
    control = tmp_path / 'recovery'
    for path in (queue, store, control):
        path.mkdir(parents=True)
    (queue / 'owner.lock').write_text(json.dumps({'pid': 9999}))
    (queue / 'jobs.json').write_text(json.dumps({'status': 'execution_unknown'}))
    (store / 'run.json').write_text(json.dumps({'status': 'execution_unknown'}))
    (control / 'provider.sqlite3').write_bytes(b'independent evidence')
    monkeypatch.setattr(recovery, 'process_dead', lambda pid: True)
    monkeypatch.setattr(recovery, 'engine_ids', lambda cfg: [])
    return {'host': '127.0.0.1', 'provider': 'simulated', 'recoveryDir': str(control),
            'jobQueue': {'dataDir': str(queue)}, 'workspaces': [{
                'workspaceId': 'a', 'tenantId': 'a', 'dataDir': str(store),
                'engine': {'root': str(store.parent)}}]}


def snapshot(config):
    roots = [Path(config['jobQueue']['dataDir']),
             Path(config['workspaces'][0]['engine']['root']),
             Path(config['recoveryDir'])]
    return {str(path): path.read_bytes() for root in roots
            for path in root.rglob('*') if path.is_file()}


def locks(config, content=None):
    store = Path(config['workspaces'][0]['dataDir'])
    paths = [store / 'workspace.preparation.lock', store / 'run.publication.lock']
    for path in paths:
        path.write_text(content or json.dumps({'pid': 9999, 'acquiredAt': 'past'}))
    return paths


def test_dead_owner_recovers_both_locks_without_changing_operations(config):
    paths = locks(config)
    owner = Path(config['jobQueue']['dataDir']) / 'owner.lock'
    before = snapshot(config)
    result = recovery.recover(config)
    assert result == {'recovered': True, 'deadPid': 9999,
                      'stoppedEngines': 0, 'storeLocks': 2}
    assert snapshot(config) == {path: value for path, value in before.items()
                                if path not in {str(owner), *(str(p) for p in paths)}}
    assert recovery.recover(config) == {'recovered': False}


@pytest.mark.parametrize('lock_name', ['workspace.preparation.lock', 'run.publication.lock'])
def test_unowned_lock_blocks_recovery(config, lock_name):
    (Path(config['jobQueue']['dataDir']) / 'owner.lock').unlink()
    (Path(config['workspaces'][0]['dataDir']) / lock_name).write_text('{"pid":9999}')
    before = snapshot(config)
    with pytest.raises(RuntimeError, match='without an owner'):
        recovery.recover(config)
    assert snapshot(config) == before


@pytest.mark.parametrize('content', ['{"pid":8888}', '{"pid":true}', '{}', '{broken'])
def test_unattributed_or_malformed_lock_preserves_all_locks(config, content):
    paths = locks(config)
    paths[1].write_text(content)
    before = snapshot(config)
    with pytest.raises((RuntimeError, json.JSONDecodeError)):
        recovery.recover(config)
    assert snapshot(config) == before


def test_active_owner_preserves_new_locks(config, monkeypatch):
    locks(config)
    before = snapshot(config)
    monkeypatch.setattr(recovery, 'process_dead', lambda pid: False)
    with pytest.raises(RuntimeError, match='Owner is active'):
        recovery.recover(config)
    assert snapshot(config) == before


def test_restore_fence_preserves_new_locks(config):
    locks(config)
    (Path(config['recoveryDir']) / 'restore.lock').write_bytes(b'active restore')
    before = snapshot(config)
    with pytest.raises(RuntimeError, match='Restore in progress'):
        recovery.recover(config)
    assert snapshot(config) == before
