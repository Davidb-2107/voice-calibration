import json
import os
from pathlib import Path
import subprocess
import sys
import pytest
from filelock import FileLock, Timeout
import recover_owner as recovery
actual_engine_ids = recovery.engine_ids


@pytest.fixture
def config(tmp_path, monkeypatch):
    queue = tmp_path / 'data/queue'
    store = tmp_path / 'data/a/ui'
    queue.mkdir(parents=True)
    store.mkdir(parents=True)
    control = tmp_path / 'recovery'
    control.mkdir()
    cfg = {'host': '127.0.0.1', 'provider': 'simulated', 'recoveryDir': str(control),
        'jobQueue': {'dataDir': str(queue)}, 'workspaces': [{'workspaceId': 'workspace-a', 'tenantId': 'tenant-a',
            'dataDir': str(store), 'engine': {'root': str(store.parent)}}]}
    (queue / 'owner.lock').write_text(json.dumps({'pid': 9999}))
    (store / 'run.json').write_text(json.dumps({'status': 'execution_unknown'}))
    (store / 'run.json.lock').write_text(json.dumps({'pid': 9999, 'acquiredAt': 'past'}))
    (store / '.instance.lock').write_bytes(b'')
    (control / 'provider.sqlite3').write_bytes(b'proofs')
    monkeypatch.setattr(recovery, 'process_dead', lambda pid: True)
    monkeypatch.setattr(recovery, 'engine_ids', lambda config: [])
    return cfg


def owner(config):
    return Path(config['jobQueue']['dataDir']) / 'owner.lock'


def test_dead_owner_cleanup_keeps_unknown_operations_and_evidence(config):
    result = recovery.recover(config)
    assert result == {'recovered': True, 'deadPid': 9999, 'stoppedEngines': 0, 'storeLocks': 1}
    store = Path(config['workspaces'][0]['dataDir'])
    assert not owner(config).exists() and not (store / 'run.json.lock').exists()
    assert json.loads((store / 'run.json').read_text())['status'] == 'execution_unknown'
    assert (store / '.instance.lock').exists()
    assert (Path(config['recoveryDir']) / 'provider.sqlite3').read_bytes() == b'proofs'


@pytest.mark.parametrize('record', [{}, {'pid': True}, {'pid': -1}, {'pid': 9999, 'restore_id': 'restore'}, None])
def test_invalid_owners_are_not_removed(config, record, monkeypatch):
    monkeypatch.setattr(recovery, 'process_dead', lambda pid: recovery_process(pid))
    def recovery_process(pid):
        if type(pid) is not int or pid <= 0:
            raise RuntimeError('invalid')
        return True
    owner(config).write_text(json.dumps(record))
    with pytest.raises((RuntimeError, TypeError, KeyError)):
        recovery.recover(config)
    assert owner(config).exists()


def test_active_or_reused_pid_is_never_taken_over(config, monkeypatch):
    monkeypatch.setattr(recovery, 'process_dead', lambda pid: False)
    with pytest.raises(RuntimeError, match='active'):
        recovery.recover(config)
    assert owner(config).exists()


def test_unknown_process_state_blocks(config, monkeypatch):
    def unknown(pid):
        raise RuntimeError('Cannot establish owner process state')
    monkeypatch.setattr(recovery, 'process_dead', unknown)
    with pytest.raises(RuntimeError, match='Cannot establish'):
        recovery.recover(config)
    assert owner(config).exists()


def test_restore_fence_prevents_cleanup(config):
    (Path(config['recoveryDir']) / 'restore.lock').write_text('restoring')
    with pytest.raises(RuntimeError, match='Restore in progress'):
        recovery.recover(config)
    assert owner(config).exists()


def test_foreign_store_owner_blocks_cleanup(config):
    (Path(config['workspaces'][0]['dataDir']) / 'run.json.lock').write_text('{"pid":1234}')
    with pytest.raises(RuntimeError, match='Unattributed'):
        recovery.recover(config)
    assert owner(config).exists()


def test_owner_change_during_engine_stop_blocks(config, monkeypatch):
    answers = iter([['engine'], []])
    monkeypatch.setattr(recovery, 'engine_ids', lambda config: next(answers))
    def stop(*args, **kwargs):
        owner(config).write_text('{"pid":1234}')
        return subprocess.CompletedProcess('docker', 0)
    monkeypatch.setattr(subprocess, 'run', stop)
    with pytest.raises(RuntimeError, match='changed'):
        recovery.recover(config)
    assert json.loads(owner(config).read_text()) == {'pid': 1234}


def test_engine_cleanup_failure_keeps_owner(config, monkeypatch):
    monkeypatch.setattr(recovery, 'engine_ids', lambda config: ['engine'])
    def fail(*args, **kwargs):
        raise subprocess.CalledProcessError(1, 'docker')
    monkeypatch.setattr(subprocess, 'run', fail)
    with pytest.raises(subprocess.CalledProcessError):
        recovery.recover(config)
    assert owner(config).exists()


def test_linked_store_is_not_followed(config, tmp_path):
    link = tmp_path / 'linked'
    try:
        link.symlink_to(config['workspaces'][0]['dataDir'], target_is_directory=True)
    except OSError:
        pytest.skip('Symlink creation unavailable')
    config['workspaces'][0]['dataDir'] = str(link)
    with pytest.raises(RuntimeError, match='Linked'):
        recovery.recover(config)


def test_unowned_engine_without_owner_blocks(config, monkeypatch):
    owner(config).unlink()
    monkeypatch.setattr(recovery, 'engine_ids', lambda config: ['engine'])
    with pytest.raises(RuntimeError, match='without an owner'):
        recovery.recover(config)


def test_store_lock_without_owner_blocks(config):
    owner(config).unlink()
    with pytest.raises(RuntimeError, match='Store locks present'):
        recovery.recover(config)


def test_pid_cannot_wrap_windows_process_id():
    with pytest.raises(RuntimeError, match='Invalid owner PID'):
        recovery.process_dead(2**32)


@pytest.mark.parametrize('still_active', [False, True])
def test_container_disappearance_is_confirmed(config, monkeypatch, still_active):
    def output(args, **kwargs):
        if args[1] == 'inspect':
            raise subprocess.CalledProcessError(1, args)
        if '--filter' in args:
            return 'gone' if still_active else ''
        return 'gone'
    monkeypatch.setattr(subprocess, 'check_output', output)
    if still_active:
        with pytest.raises(RuntimeError, match='Cannot inspect'):
            actual_engine_ids(config)
    else:
        assert actual_engine_ids(config) == []


def test_startup_kernel_lock_is_released_on_supervisor_crash(tmp_path):
    script = tmp_path / 'supervisor.py'
    lock = tmp_path / 'startup.lock'
    script.write_text('from filelock import FileLock\nimport sys,time\nwith FileLock(sys.argv[1]):\n print("ready",flush=True)\n time.sleep(30)\n')
    child = subprocess.Popen([sys.executable, str(script), str(lock)], stdout=subprocess.PIPE, text=True)
    try:
        assert child.stdout.readline().strip() == 'ready'
        with pytest.raises(Timeout):
            FileLock(str(lock), timeout=0).acquire()
    finally:
        child.kill()
        child.wait(timeout=10)
        child.stdout.close()
    with FileLock(str(lock), timeout=1):
        assert lock.exists()


@pytest.mark.parametrize('parent_mount', [False, True])
def test_foreign_mount_is_never_killed(config, monkeypatch, parent_mount):
    root = config['workspaces'][0]['engine']['root']
    if parent_mount:
        root = str(Path(root).parent)
    row = {'Id': 'foreign', 'Name': '/foreign-container', 'Mounts': [{'Type': 'bind', 'Source': root, 'Destination': '/workspace'}],
           'Config': {'Env': ['VOICE_CALIBRATION_WORKSPACE_ID=foreign', 'VOICE_CALIBRATION_TENANT_ID=tenant-a']}}
    monkeypatch.setattr(subprocess, 'check_output', lambda args, **kw: 'foreign' if args[1] == 'ps' else json.dumps([row]))
    # Fixture replaces engine_ids; exercise the actual attribution implementation.
    import importlib.util
    spec = importlib.util.spec_from_file_location('real_recovery', recovery.__file__)
    real = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(real)
    with pytest.raises(RuntimeError, match='Unattributed'):
        real.engine_ids(config)


def test_kernel_startup_lock_serializes_supervisors(tmp_path):
    lock = FileLock(str(tmp_path / 'startup.lock'))
    with lock:
        with pytest.raises(Timeout):
            FileLock(str(tmp_path / 'startup.lock'), timeout=0).acquire()

def test_attributed_container_parent_mount_cannot_cross_workspaces(config,monkeypatch):
    root=Path(config['workspaces'][0]['engine']['root'])
    other=root.parent/'b';other.mkdir()
    config['workspaces'].append({'workspaceId':'workspace-b','tenantId':'tenant-b','engine':{'root':str(other)}})
    row={'Id':'claimed','Name':'/calibration-engine-00000000-0000-0000-0000-000000000000',
        'Mounts':[{'Type':'bind','Source':str(root),'Destination':'/workspace'},
            {'Type':'bind','Source':str(root.parent),'Destination':'/parent'}],
        'Config':{'Env':['VOICE_CALIBRATION_WORKSPACE_ID=workspace-a','VOICE_CALIBRATION_TENANT_ID=tenant-a']}}
    monkeypatch.setattr(subprocess,'check_output',lambda args,**kw:'claimed' if args[1]=='ps' else json.dumps([row]))
    with pytest.raises(RuntimeError,match='crosses workspace'):
        actual_engine_ids(config)


def test_real_process_liveness_and_exit():
    # Use the genuine platform process probe, not the fixture stub.
    assert not recovery.process_dead(os.getpid())
    child = subprocess.Popen([sys.executable, '-c', 'pass'])
    child.wait(timeout=10)
    assert recovery.process_dead(child.pid)
