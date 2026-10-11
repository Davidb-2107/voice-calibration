"""Restore local data under a durable, independently stored paid-operation quarantine."""
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys
import uuid

HERE = Path(__file__).resolve().parent

def hashes(root):
    result = {}
    for path in sorted(root.rglob('*')):
        if path.is_symlink():
            raise RuntimeError('Linked backup entries are forbidden')
        if path.is_file():
            result[path.relative_to(root).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result

def write_record(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    with temporary.open('x', encoding='utf-8') as stream:
        json.dump(value, stream, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)

def restore(config, backup, manifest):
    data = Path(config['jobQueue']['dataDir']).resolve().parent
    recovery = Path(config['recoveryDir']).resolve()
    backup = backup.resolve()
    if any(a == b or a.is_relative_to(b) or b.is_relative_to(a)
           for a, b in ((data, recovery), (data, backup), (recovery, backup))):
        raise RuntimeError('Restore source, data and recovery control must be disjoint')
    if hashes(backup) != manifest or 'queue/owner.lock' in manifest:
        raise RuntimeError('Backup manifest mismatch or active owner in snapshot')
    recovery.mkdir(parents=True, exist_ok=True)
    operation = uuid.uuid4().hex
    lock = recovery / 'restore.lock'
    with lock.open('x') as stream:
        stream.write(operation)
        stream.flush()
        os.fsync(stream.fileno())
    # On failure the marker stays: startup must refuse a partially restored dataset.
    if (data / 'queue/owner.lock').exists():
        raise RuntimeError('Stop the API before restoring')
    queue = data / 'queue'
    queue.mkdir(parents=True, exist_ok=True)
    claim = {'pid': os.getpid(), 'restore_id': operation}
    # The queue's exclusive owner claim also excludes an API racing with startup.
    with (queue / 'owner.lock').open('x') as stream:
        json.dump(claim, stream)
        stream.flush()
        os.fsync(stream.fileno())
    evidence = hashes(data)
    evidence.pop('queue/owner.lock', None)
    evidence_file = recovery / (operation + '.evidence.json')
    write_record(evidence_file, evidence)
    evidence_digest = hashlib.sha256(evidence_file.read_bytes()).hexdigest()
    provider_snapshots = []
    for workspace in config['workspaces']:
        control = Path(workspace['engine']['restoreGuardDir']).resolve()
        if config.get('providerRegistryRequired') or (control / 'provider-registry').exists():
            if not control.is_relative_to(recovery) or not re.fullmatch(r'[a-z0-9][a-z0-9_-]*', workspace['workspaceId']):
                raise RuntimeError('Invalid independent provider snapshot destination')
            from application.provider_registry import ProviderRegistry
            registry = ProviderRegistry(control / 'provider-registry', control / 'provider-registry.key',
                                        workspace['workspaceId'], workspace['tenantId'])
            snapshot = recovery / (operation + '.' + workspace['workspaceId'] + '.provider.sqlite3')
            provider_snapshots.append({'workspace_id': workspace['workspaceId'], 'file': snapshot.name,
                                       'sha256': registry.snapshot(snapshot)})
    guards = []
    for workspace in config['workspaces']:
        guard = Path(workspace['engine']['restoreGuardDir']).resolve() / 'guard.json'
        if not guard.is_relative_to(recovery):
            raise RuntimeError('Restore guard must stay in independent recovery storage')
        guards.append((guard, workspace['workspaceId']))
    for guard, workspace_id in guards:
        write_record(guard, {'version': 1, 'workspace_id': workspace_id, 'state': 'quarantined',
            'restore_id': operation, 'reason': 'Restored approvals require independent reconciliation'})
    stage = data.with_name(data.name + '.restore-' + operation)
    previous = data.with_name(data.name + '.before-restore-' + operation)
    shutil.copytree(backup, stage)
    if hashes(stage) != manifest:
        raise RuntimeError('Staged restore verification failed')
    data.rename(previous)
    stage.rename(data)
    previous_claim = previous / 'queue/owner.lock'
    if json.loads(previous_claim.read_text()) != claim:
        raise RuntimeError('Restore ownership changed unexpectedly')
    previous_claim.unlink()
    record = {'restore_id': operation, 'state': 'quarantined', 'files': len(manifest),
              'previous_data': str(previous), 'restored_data': str(data),
              'evidence_manifest': evidence_file.name, 'evidence_sha256': evidence_digest,
              'provider_snapshots': provider_snapshots}
    write_record(recovery / (operation + '.json'), record)
    lock.unlink()
    return record

if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('Usage: python preproduction/restore.py BACKUP_DIR MANIFEST_JSON')
    config = json.loads((HERE / 'config.json').read_text())
    assert config['host'] == '127.0.0.1' and config['provider'] == 'simulated'
    assert not (Path(config['jobQueue']['dataDir']) / 'owner.lock').exists(), 'Stop the API first'
    ids = subprocess.check_output(['docker', 'ps', '-q'], text=True).split()
    if ids:
        rows = json.loads(subprocess.check_output(['docker', 'inspect', *ids], text=True))
        data = Path(config['jobQueue']['dataDir']).resolve().parent
        assert not any(Path(m['Source']).resolve().is_relative_to(data) for row in rows for m in row['Mounts']), 'Workspace engines must be stopped'
    print(json.dumps(restore(config, Path(sys.argv[1]), json.loads(Path(sys.argv[2]).read_text()))))
