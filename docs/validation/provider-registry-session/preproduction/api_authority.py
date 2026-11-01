"""Seal immutable controller programs separately from the candidate and mutable state."""
import hashlib
import hmac
import json
from contextlib import contextmanager
from pathlib import Path

from windows_candidate import _canonical

CACHE_POLICY = 'stdlib-zip-only-v1'


@contextmanager
def operator_lock(root, name, timeout):
    """Manual and automatic entrypoints verify programs before importing their SDK lock."""
    from windows_api_candidate import WindowsApiCandidate
    root = Path(root)
    config_bytes = (root / 'config.json').read_bytes()
    config = json.loads(config_bytes)
    guard = WindowsApiCandidate.open(Path(config['windowsApiRoot']))
    if root.resolve() != guard._authority / 'control':
        raise RuntimeError('Operator must belong to the qualified independent authority')
    payload = guard._load_payload()
    public_path = guard.code / 'api-public.json'
    public_bytes = public_path.read_bytes()
    if hashlib.sha256(public_bytes).hexdigest() != payload['code']['api-public.json']['sha256']:
        raise RuntimeError('Qualified API controller binding changed')
    if json.loads(public_bytes)['controlConfigSha256'] != hashlib.sha256(config_bytes).hexdigest():
        raise RuntimeError('Operator configuration does not match API qualification')
    locks = []
    try:
        verify(guard, locks)
        from filelock import FileLock
        with FileLock(str(root / name), timeout=timeout):
            yield
    finally:
        for handle in locks:
            guard._api.kernel.CloseHandle(handle)


def inventory(guard, roots, locks=None):
    result = {}
    for name in roots:
        root = guard.root / name
        if not root.resolve().is_relative_to(guard._authority):
            raise RuntimeError('Controller programs must stay in the independent authority')
        paths = [root, *sorted(root.rglob('*'))] if root.is_dir() else [root]
        for path in paths:
            metadata = path.stat(follow_symlinks=False)
            if path.suffix.lower() in ('.pyc', '.pyo') or path.name == '__pycache__':
                raise RuntimeError('Loose Python caches are forbidden in qualified controller programs')
            if metadata.st_file_attributes & 0x400 or (path.is_file() and metadata.st_nlink != 1):
                raise RuntimeError('Controller aliases are forbidden')
            guard._api.reject_named_streams(path)
            value = {'security': guard._api.security_descriptor(path), 'directory': path.is_dir()}
            if path.is_file():
                if locks is not None:
                    locks.append(guard._api.lock_file(path))
                value['sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
            result[path.relative_to(guard.root).as_posix()] = value
    return result


def seal(guard, roots):
    target = guard._authority / 'api-controller.json'
    if target.exists():
        raise RuntimeError('Controller already sealed; create a new inactive root')
    for name in roots:
        root = guard.root / name
        if not root.resolve().is_relative_to(guard._authority):
            raise RuntimeError('Controller programs must stay in the independent authority')
        for path in ([root, *root.rglob('*')] if root.is_dir() else [root]):
            guard._protect(path, 'authority')
    payload = {'schema': 'api-controller-v1', 'root': str(guard.root), 'cache_policy': CACHE_POLICY, 'roots': roots,
               'files': inventory(guard, roots)}
    signature = hmac.new(guard.authority_key.read_bytes(), _canonical(payload), hashlib.sha256).hexdigest()
    target.write_text(json.dumps({'payload': payload, 'signature': signature}, indent=2), encoding='utf-8')
    guard._protect(target, 'authority')


def verify(guard, locks):
    target = guard._authority / 'api-controller.json'
    guard._api.check_protection(target, guard.authority_identity['user_sid'], None, 'authority')
    record = json.loads(target.read_text(encoding='utf-8'))
    payload = record['payload']
    expected = hmac.new(guard.authority_key.read_bytes(), _canonical(payload), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(record['signature'], expected):
        raise RuntimeError('Independent controller signature invalid')
    if (payload['schema'] != 'api-controller-v1' or payload['root'] != str(guard.root)
            or payload.get('cache_policy') != CACHE_POLICY):
        raise RuntimeError('Independent controller belongs to another root')
    if inventory(guard, payload['roots'], locks) != payload['files']:
        raise RuntimeError('Independent controller code, caches or protection changed')
    native = guard._load_payload()
    if guard._snapshot(locks) != native['code']:
        raise RuntimeError('Qualified API code or protection changed before business imports')
    control = guard._authority / 'control'
    if (control / '__pycache__').exists() or list(control.glob('*.pyc')):
        raise RuntimeError('Operator caches are forbidden before business imports')
    config_bytes = (control / 'config.json').read_bytes()
    config = json.loads(config_bytes)
    public = json.loads((guard.code / 'api-public.json').read_bytes())
    required = ['authority/runtime', 'authority/broker-api']
    if any(name not in payload['roots'] for name in required):
        raise RuntimeError('Complete private SDK and controller library must be sealed')
    for name in ('api_supervisor.py', 'api_authority.py', 'node_runtime.py', 'operator_runtime.py',
            'windows_candidate.py', 'windows_api_candidate.py', 'api_broker.mjs',
            'financial_preflight.py', 'financial_preflight.mjs', 'provider_registry_status.py',
            'boot_watchdog.py', 'watchdog.py', 'control.py', 'release.py', 'install_provider_registry.py',
            'recover_owner.py', 'config.json', 'boot-runtime.json'):
        if 'authority/control/'+name not in payload['files']:
            raise RuntimeError('Unsealed controller program: '+name)
    if public['controlConfigSha256'] != hashlib.sha256(config_bytes).hexdigest():
        raise RuntimeError('API and independent controller configuration differ')
    if (Path(config['windowsApiRoot']).resolve() != guard.root or config['host'] != '127.0.0.1'
            or config['provider'] != 'simulated'):
        raise RuntimeError('Qualified local simulated API binding required')
    expected_paths = {'registryPython': guard._authority / 'runtime/python.exe',
        'brokerModule': guard._authority / 'broker-api/dist/index.js',
        'module': guard.code / 'api/dist/index.js', 'releaseDir': guard.code / 'api'}
    for field, expected_path in expected_paths.items():
        if Path(config[field]).resolve() != expected_path:
            raise RuntimeError('Unqualified API/controller program path: '+field)
    if public['module'] != config['module']:
        raise RuntimeError('API module differs from financial target')
    for field in ('host', 'apiPort', 'image', 'jobQueue', 'supabase'):
        if public[field] != config[field]:
            raise RuntimeError('Public and private API binding differ: '+field)
    private_workspaces = {workspace['workspaceId']: workspace for workspace in config['workspaces']}
    if len(private_workspaces) != len(config['workspaces']) or len(public['workspaces']) != len(private_workspaces):
        raise RuntimeError('Duplicate or missing workspace registration')
    for workspace in public['workspaces']:
        private = private_workspaces[workspace['workspaceId']]
        if 'credentials' in workspace:
            raise RuntimeError('Business credentials cannot be stored in the public artifact')
        for field in ('workspaceId', 'tenantId', 'dataDir', 'stateDir', 'wpmPath'):
            if workspace[field] != private[field]:
                raise RuntimeError('Workspace binding differs: '+field)
        public_engine = {key: value for key, value in workspace['engine'].items() if key != 'restoreGuardDir'}
        private_engine = {key: value for key, value in private['engine'].items() if key != 'restoreGuardDir'}
        if public_engine != private_engine:
            raise RuntimeError('Workspace engine binding differs')
        handle = Path(workspace['engine']['restoreGuardDir']).resolve()
        if not handle.is_relative_to(guard.code) or not native['code'][handle.relative_to(guard.code).as_posix()]['directory']:
            raise RuntimeError('Public guard handle must be qualified code without a signing key')
    runtime = guard._authority / 'runtime'
    lines = (runtime / 'python312._pth').read_text(encoding='utf-8-sig').splitlines()
    paths = set()
    for line in lines:
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        if line.startswith('import ') or Path(line).is_absolute():
            raise RuntimeError('Ambient site or absolute Python import paths are forbidden')
        path = (runtime / line).resolve()
        if not path.is_relative_to(runtime):
            raise RuntimeError('Python import path leaves qualified SDK')
        paths.add(path)
    if paths != {runtime, runtime / 'python312.zip', runtime / 'Lib/site-packages'}:
        raise RuntimeError('Unexpected qualified Python import policy')
    if (guard._authority / 'work/supabase-tenant-adapter/Shared/voice-calibration').exists():
        raise RuntimeError('Borrowed source-checkout SDK is forbidden')
    boot = json.loads((control / 'boot-runtime.json').read_bytes())
    if Path(boot['python']).resolve() != expected_paths['registryPython'] or Path(boot['node']).resolve() != Path(native['argv'][0]):
        raise RuntimeError('Boot and child runtime paths differ')
