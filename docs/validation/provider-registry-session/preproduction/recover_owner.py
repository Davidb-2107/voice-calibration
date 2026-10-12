"""Local supervisor recovery; uncertain operations are never dispatched here."""
import ctypes
import json
import os
from pathlib import Path
import re
import subprocess


def process_dead(pid):
    if type(pid) is not int or not 0 < pid <= 0xFFFFFFFF:
        raise RuntimeError('Invalid owner PID')
    if os.name == 'nt':
        from ctypes import wintypes
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel.WaitForSingleObject.restype = wintypes.DWORD
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel.OpenProcess(0x00100000, False, pid)
        if not handle:
            if ctypes.get_last_error() == 87:
                return True
            raise RuntimeError('Cannot establish owner process state')
        try:
            result = kernel.WaitForSingleObject(handle, 0)
            if result not in (0, 258):
                raise RuntimeError('Cannot establish owner process state')
            return result == 0
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    except PermissionError as error:
        raise RuntimeError('Cannot establish owner process state') from error
    return False


def checked(path):
    path = Path(path).absolute()
    if any(p.is_symlink() or p.is_junction() for p in (path, *path.parents)):
        raise RuntimeError('Linked recovery paths forbidden')
    return path.resolve()


def engine_ids(config):
    ids = subprocess.check_output(['docker', 'ps', '-q'], text=True, timeout=10).split()
    if not ids:
        return []
    rows = []
    for identity in ids:
        try:
            rows.extend(json.loads(subprocess.check_output(['docker', 'inspect', identity], text=True, stderr=subprocess.PIPE, timeout=10)))
        except subprocess.CalledProcessError:
            # --rm engines can disappear between enumeration and inspection.
            if subprocess.check_output(['docker', 'ps', '-q', '--filter', 'id=' + identity], text=True, timeout=10).strip():
                raise RuntimeError('Cannot inspect an active container; recovery blocked')
    owned = []
    for row in rows:
        mounts = {checked(m['Source']): m['Destination'] for m in row['Mounts'] if m['Type'] == 'bind'}
        for w in config['workspaces']:
            root = checked(w['engine']['root'])
            if not any(p.is_relative_to(root) or root.is_relative_to(p) for p in mounts):
                continue
            values = dict(e.split('=', 1) for e in row['Config']['Env'] if '=' in e)
            if (not re.fullmatch(r'/calibration-engine-[a-f0-9-]{36}', row['Name'])
                or values.get('VOICE_CALIBRATION_WORKSPACE_ID') != w['workspaceId']
                or values.get('VOICE_CALIBRATION_TENANT_ID') != w['tenantId']
                or mounts.get(root) != '/workspace'):
                raise RuntimeError('Unattributed container using workspace storage')
            # A container crossing workspace roots cannot be safely claimed.
            for other in config['workspaces']:
                other_root = checked(other['engine']['root'])
                if other is not w and any(p.is_relative_to(other_root) or other_root.is_relative_to(p) for p in mounts):
                    raise RuntimeError('Container crosses workspace boundaries')
            owned.append(row['Id'])
    return list(dict.fromkeys(owned))


def recover(config):
    """Caller holds the OS startup lock through recovery AND API startup."""
    if config['host'] != '127.0.0.1' or config['provider'] != 'simulated':
        raise RuntimeError('Recovery is limited to the local simulated service')
    fence = checked(Path(config['recoveryDir']) / 'restore.lock')
    if fence.exists():
        raise RuntimeError('Restore in progress; recovery blocked')
    queue = checked(config['jobQueue']['dataDir'])
    roots = [checked(w['engine']['root']) for w in config['workspaces']]
    stores = [checked(w['dataDir']) for w in config['workspaces']]
    for index, root in enumerate(roots):
        if stores[index] == root or not stores[index].is_relative_to(root):
            raise RuntimeError('Store outside its private workspace')
        for other in [queue, *roots[:index], *roots[index + 1:]]:
            if root == other or root.is_relative_to(other) or other.is_relative_to(root):
                raise RuntimeError('Recovery roots overlap')
    owner = checked(queue / 'owner.lock')
    if not owner.exists():
        # Also fail closed if unowned workspace engines are still running.
        if engine_ids(config):
            raise RuntimeError('Engines present without an owner; recovery blocked')
        if any(list(store.rglob('*.json.lock')) for store in stores):
            raise RuntimeError('Store locks present without an owner; recovery blocked')
        return {'recovered': False}
    original = owner.read_bytes()
    record = json.loads(original)
    if set(record) != {'pid'} or not process_dead(record['pid']):
        raise RuntimeError('Owner is active or not an API owner; recovery blocked')
    pid = record['pid']
    roots = [queue, *stores]
    locks = []
    for root in roots:
        for entry in root.rglob('*'):
            checked(entry)
            if not entry.is_file() or not entry.name.endswith('.json.lock'):
                continue
            content = entry.read_bytes()
            lock = json.loads(content)
            if type(lock.get('pid')) is not int or lock['pid'] != pid:
                raise RuntimeError('Unattributed store lock; recovery blocked')
            locks.append((entry, content))
    stopped = engine_ids(config)
    for identity in stopped:
        result = subprocess.run(['docker', 'rm', '--force', identity], capture_output=True, timeout=30)
        if result.returncode and subprocess.check_output(['docker', 'ps', '-q', '--filter', 'id=' + identity], text=True, timeout=10).strip():
            raise RuntimeError('Cannot stop orphan engine; recovery blocked')
    if engine_ids(config):
        raise RuntimeError('Workspace engines still active; recovery blocked')
    if fence.exists() or owner.read_bytes() != original or not process_dead(pid):
        raise RuntimeError('Owner or restore state changed; recovery blocked')
    # Only stale Node locks are removed; Python OS locks and provider evidence stay intact.
    for path, content in locks:
        if checked(path).read_bytes() != content:
            raise RuntimeError('Store lock changed; recovery blocked')
    for path, _ in locks:
        path.unlink()
    owner.unlink()
    return {'recovered': True, 'deadPid': pid, 'stoppedEngines': len(stopped), 'storeLocks': len(locks)}
