import json
from pathlib import Path
import pytest
from restore import restore, hashes

def fixture(tmp_path):
    data, backup, recovery = (tmp_path / name for name in ('data', 'backup', 'recovery'))
    data.mkdir()
    backup.mkdir()
    (data / 'spent.json').write_text('{"consumed":true}')
    (backup / 'approved.json').write_text('{"consumed":false}')
    config = {'jobQueue': {'dataDir': str(data / 'queue')}, 'recoveryDir': str(recovery),
        'workspaces': [{'workspaceId': 'a', 'engine': {'restoreGuardDir': str(recovery / 'a')}}]}
    return data, backup, recovery, config

def test_restore_keeps_quarantine_outside_snapshot_and_archives_spent_evidence(tmp_path):
    data, backup, recovery, config = fixture(tmp_path)
    result = restore(config, backup, hashes(backup))
    assert hashes(data) == hashes(backup)
    assert json.loads((recovery / 'a/guard.json').read_text())['state'] == 'quarantined'
    assert json.loads((Path(result['previous_data']) / 'spent.json').read_text())['consumed']
    second = restore(config, backup, hashes(backup))
    assert second['restore_id'] != result['restore_id']
    assert json.loads((recovery / 'a/guard.json').read_text())['state'] == 'quarantined'

def test_invalid_backup_is_refused_without_replacing_data(tmp_path):
    data, backup, recovery, config = fixture(tmp_path)
    with pytest.raises(RuntimeError, match='manifest'):
        restore(config, backup, {})
    assert (data / 'spent.json').exists()

def test_interrupted_restore_retains_marker_and_quarantine(tmp_path, monkeypatch):
    import restore as module
    data, backup, recovery, config = fixture(tmp_path)
    monkeypatch.setattr(module.shutil, 'copytree', lambda *args: (_ for _ in ()).throw(OSError('interrupted')))
    with pytest.raises(OSError):
        restore(config, backup, hashes(backup))
    assert (recovery / 'restore.lock').exists()
    assert (data / 'queue/owner.lock').exists()
    assert json.loads((recovery / 'a/guard.json').read_text())['state'] == 'quarantined'
    with pytest.raises(FileExistsError):
        restore(config, backup, hashes(backup))

def test_restore_preserves_a_live_owner(tmp_path):
    data, backup, recovery, config = fixture(tmp_path)
    queue = data / 'queue'
    queue.mkdir()
    owner = queue / 'owner.lock'
    owner.write_text('{"pid":123}')
    with pytest.raises(RuntimeError, match='Stop the API'):
        restore(config, backup, hashes(backup))
    assert owner.read_text() == '{"pid":123}'
    assert (data / 'spent.json').exists()
