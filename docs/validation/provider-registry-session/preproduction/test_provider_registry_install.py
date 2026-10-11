import json
from pathlib import Path

import pytest

import install_provider_registry as installer


def prepare(tmp_path, monkeypatch):
    queue, recovery = tmp_path / 'data/queue', tmp_path / 'recovery'
    queue.mkdir(parents=True)
    recovery.mkdir()
    config = {'host': '127.0.0.1', 'provider': 'simulated', 'image': 'sha256:old',
              'jobQueue': {'dataDir': str(queue)}, 'recoveryDir': str(recovery), 'workspaces': []}
    (tmp_path / 'config.json').write_text(json.dumps(config))
    monkeypatch.setattr(installer, 'HERE', tmp_path)
    monkeypatch.setattr(installer.shutil, 'copyfile', lambda *args: None)
    monkeypatch.setattr(installer.shutil, 'copytree', lambda *args, **kwargs: None)

    def output(command, **kwargs):
        if command == ['docker', 'ps', '-q']:
            return ''
        return 'sha256:old' if 'provider-base-' in command[-1] else 'sha256:new'

    monkeypatch.setattr(installer.subprocess, 'check_output', output)
    return queue / 'owner.lock', recovery / 'restore.lock'


def test_install_claims_exclude_startup_restore_and_second_install_until_config_written(tmp_path, monkeypatch):
    owner, lock = prepare(tmp_path, monkeypatch)
    observed = []

    def check_claims():
        assert json.loads(owner.read_text()) == json.loads(lock.read_text())
        assert 'install_id' in json.loads(owner.read_text())
        for path in (owner, lock):
            with pytest.raises(FileExistsError):
                path.open('x')
        with pytest.raises(RuntimeError, match='Stop API'):
            installer.install()
        observed.append(True)

    def run(command, **kwargs):
        check_claims()

    original_write = installer.write_record

    def write(path, value):
        check_claims()
        original_write(path, value)

    monkeypatch.setattr(installer.subprocess, 'run', run)
    monkeypatch.setattr(installer, 'write_record', write)
    installer.install()
    assert len(observed) == 3
    assert json.loads((tmp_path / 'config.json').read_text())['image'] == 'sha256:new'
    assert not owner.exists() and not lock.exists()


def test_failed_build_keeps_claims_and_old_configuration(tmp_path, monkeypatch):
    owner, lock = prepare(tmp_path, monkeypatch)

    def run(command, **kwargs):
        if command[1] == 'build':
            raise RuntimeError('build interrupted')

    monkeypatch.setattr(installer.subprocess, 'run', run)
    with pytest.raises(RuntimeError, match='build interrupted'):
        installer.install()
    assert json.loads(owner.read_text()) == json.loads(lock.read_text())
    assert json.loads((tmp_path / 'config.json').read_text())['image'] == 'sha256:old'


@pytest.mark.parametrize('winner', ['api', 'restore'])
def test_racing_foreign_owner_is_preserved_without_installation(tmp_path, monkeypatch, winner):
    owner, lock = prepare(tmp_path, monkeypatch)
    original_validate = installer.validate
    foreign = owner if winner == 'api' else lock

    def validate(config):
        original_validate(config)
        foreign.write_text('foreign owner')

    monkeypatch.setattr(installer, 'validate', validate)
    monkeypatch.setattr(installer.subprocess, 'check_output', lambda *args, **kwargs: pytest.fail('Docker must not run'))
    with pytest.raises((RuntimeError, FileExistsError)):
        installer.install()
    assert foreign.read_text() == 'foreign owner'
    assert not (lock if winner == 'api' else owner).exists()
    assert json.loads((tmp_path / 'config.json').read_text())['image'] == 'sha256:old'


def test_changed_owner_is_not_deleted_at_installation_completion(tmp_path, monkeypatch):
    owner, lock = prepare(tmp_path, monkeypatch)
    monkeypatch.setattr(installer.subprocess, 'run', lambda *args, **kwargs: None)
    original_write = installer.write_record

    def write(path, value):
        original_write(path, value)
        owner.write_text(json.dumps({'pid': 999, 'foreign': True}))

    monkeypatch.setattr(installer, 'write_record', write)
    with pytest.raises(RuntimeError, match='ownership changed'):
        installer.install()
    assert json.loads(owner.read_text())['foreign']
    assert lock.exists()
