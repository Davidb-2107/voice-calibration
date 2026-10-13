"""Upgrade only the stopped localhost simulated preproduction; preserve quarantines."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import uuid

HERE = Path(__file__).resolve().parent
SOURCE = HERE.parent / 'work/supabase-tenant-adapter/Shared/voice-calibration'
sys.path.insert(0, str(SOURCE))
from restore import write_record


def validate(config):
    if config['host'] != '127.0.0.1' or config['provider'] != 'simulated':
        raise RuntimeError('Only local simulated preproduction may be upgraded')
    data = Path(config['jobQueue']['dataDir']).resolve().parent
    recovery = Path(config['recoveryDir']).resolve()
    if data.is_relative_to(recovery) or recovery.is_relative_to(data):
        raise RuntimeError('Independent recovery storage required')
    if (data / 'queue/owner.lock').exists() or (recovery / 'restore.lock').exists():
        raise RuntimeError('Stop API and finish restoration before upgrading')
    identities = set()
    controls = set()
    for workspace in config['workspaces']:
        identity = (workspace['tenantId'], workspace['workspaceId'])
        control = Path(workspace['engine']['restoreGuardDir']).resolve()
        if (not control.is_relative_to(recovery) or control == recovery
            or any(control.is_relative_to(other) or other.is_relative_to(control) for other in controls)
            or identity in identities):
            raise RuntimeError('Distinct independent workspace controls required')
        guard = json.loads((control / 'guard.json').read_text())
        if guard['workspace_id'] != workspace['workspaceId'] or guard['state'] not in {'ready', 'quarantined'}:
            raise RuntimeError('Invalid restore guard')
        identities.add(identity)
        controls.add(control)


def install(candidate=None):
    config = json.loads((HERE / 'config.json').read_text())
    validate(config)
    if candidate is not None:
        validate(candidate)
        for field in ('host', 'provider', 'jobQueue', 'recoveryDir'):
            if candidate[field] != config[field]:
                raise RuntimeError('Publication must preserve installation and queue bindings')
        previous = {w['workspaceId']: w for w in candidate['workspaces']}
        if any(previous.get(w['workspaceId']) != w for w in config['workspaces']):
            raise RuntimeError('Publication must preserve existing workspace bindings')
    recovery = Path(config['recoveryDir']).resolve()
    queue = Path(config['jobQueue']['dataDir']).resolve()
    claim = {'pid': os.getpid(), 'install_id': uuid.uuid4().hex}
    lock = recovery / 'restore.lock'
    with lock.open('x') as stream:
        json.dump(claim, stream)
        stream.flush()
        os.fsync(stream.fileno())
    queue.mkdir(parents=True, exist_ok=True)
    owner = queue / 'owner.lock'
    try:
        with owner.open('x') as stream:
            json.dump(claim, stream)
            stream.flush()
            os.fsync(stream.fileno())
    except FileExistsError:
        # No installation began: preserve the API owner that won the startup race.
        if json.loads(lock.read_text()) == claim:
            lock.unlink()
        raise RuntimeError('Stop API before upgrading') from None
    # An interrupted or failed installation keeps both claims for manual recovery.
    if candidate is None:
        _install(config)
    else:
        assert_engines_stopped(config)
        if json.loads((HERE / 'config.json').read_text()) != config:
            raise RuntimeError('Configuration changed during publication')
        write_record(HERE / 'config.json', candidate)
        config = candidate
    if json.loads(owner.read_text()) != claim or json.loads(lock.read_text()) != claim:
        raise RuntimeError('Installation ownership changed unexpectedly')
    owner.unlink()
    lock.unlink()
    print(json.dumps({'status': 'installed', 'image': config['image'], 'quarantine': 'unchanged', 'provider_calls': 0}))


def assert_engines_stopped(config):
    active = subprocess.check_output(['docker', 'ps', '-q'], text=True).split()
    if active:
        rows = json.loads(subprocess.check_output(['docker', 'inspect', *active], text=True))
        data = Path(config['jobQueue']['dataDir']).resolve().parent
        if any(Path(m['Source']).resolve().is_relative_to(data) for row in rows for m in row['Mounts']):
            raise RuntimeError('Workspace engines must be stopped')


def _install(config):
    from voice_calibration.core.provider_registry import ProviderRegistry
    assert_engines_stopped(config)
    for workspace in config['workspaces']:
        control = Path(workspace['engine']['restoreGuardDir'])
        directory, key = control / 'provider-registry', control / 'provider-registry.key'
        if directory.exists() or key.exists():
            registry = ProviderRegistry(directory, key, workspace['workspaceId'], workspace['tenantId'])
            registry.records()
        else:
            if config.get('providerRegistryRequired'):
                raise RuntimeError('Previously initialized provider registry missing; reconciliation required')
            ProviderRegistry.initialize(directory, key, workspace['workspaceId'], workspace['tenantId'])
    image = HERE / 'provider-registry-image'
    image.mkdir(exist_ok=True)
    for name in ['provider_registry.py', 'provider_history.py', 'context.py', 'calibration.py', 'approval_gate.py', 'egress.py']:
        shutil.copyfile(SOURCE / 'voice_calibration/core' / name, image / name)
    shutil.copyfile(SOURCE / 'voice_calibration/mcp_server/server.py', image / 'server.py')
    base_tag = 'voice-calibration-engine:provider-base-' + config['image'].removeprefix('sha256:')[:16]
    subprocess.run(['docker', 'tag', config['image'], base_tag], check=True)
    assert subprocess.check_output(['docker', 'image', 'inspect', '--format', '{{.Id}}', base_tag], text=True).strip() == config['image']
    subprocess.run(['docker', 'build', '--pull=false', '--build-arg', 'BASE_IMAGE=' + base_tag,
                    '-t', 'voice-calibration-engine:provider-registry', str(image)], check=True)
    image_id = subprocess.check_output(['docker', 'image', 'inspect', '--format', '{{.Id}}',
                                        'voice-calibration-engine:provider-registry'], text=True).strip()
    shutil.copytree(HERE.parent / 'work/supabase-calibration-auth/dist', HERE / 'application/dist', dirs_exist_ok=True)
    shutil.copyfile(SOURCE / 'voice_calibration/core/provider_registry.py', HERE / 'application/provider_registry.py')
    config.update(image=image_id, localPatch='provider-registry-uncommitted', providerRegistryRequired=True,
                  registryPython=sys.executable)
    write_record(HERE / 'config.json', config)


if __name__ == '__main__':
    install()
