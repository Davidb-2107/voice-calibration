import json
from pathlib import Path
import sys

import pytest

SOURCE = Path(__file__).resolve().parents[1] / 'work/supabase-tenant-adapter/Shared/voice-calibration'
sys.path.insert(0, str(SOURCE))
from voice_calibration.core.provider_registry import ProviderRegistry
from install_provider_registry import validate
from restore import restore, hashes
from reconcile import audit
from provider_registry_status import verify
import install_provider_registry as installer


def configuration(tmp_path):
    data, recovery = tmp_path / 'data', tmp_path / 'recovery'
    control = recovery / 'a'
    control.mkdir(parents=True)
    (control / 'guard.json').write_text(json.dumps({'version': 1, 'workspace_id': 'a', 'state': 'quarantined'}))
    return {'host': '127.0.0.1', 'provider': 'simulated', 'providerRegistryRequired': True,
            'jobQueue': {'dataDir': str(data / 'queue')}, 'recoveryDir': str(recovery),
            'workspaces': [{'workspaceId': 'a', 'tenantId': 'tenant-a', 'stateDir': str(data / 'a/state'),
                            'engine': {'restoreGuardDir': str(control)}}]}


@pytest.mark.parametrize('failure', ['public', 'paid', 'active', 'overlap', 'duplicate'])
def test_installer_refuses_unsafe_targets(tmp_path, failure):
    config = configuration(tmp_path)
    if failure == 'public':
        config['host'] = '0.0.0.0'
    elif failure == 'paid':
        config['provider'] = 'elevenlabs'
    elif failure == 'active':
        owner = Path(config['jobQueue']['dataDir']) / 'owner.lock'
        owner.parent.mkdir(parents=True)
        owner.write_text('active')
    elif failure == 'overlap':
        config['recoveryDir'] = str(tmp_path / 'data/recovery')
    else:
        config['workspaces'].append(config['workspaces'][0])
    with pytest.raises(RuntimeError):
        validate(config)


def test_installer_does_not_recreate_a_lost_initialized_registry(tmp_path, monkeypatch):
    config = configuration(tmp_path)
    (tmp_path / 'config.json').write_text(json.dumps(config))
    monkeypatch.setattr(installer, 'HERE', tmp_path)
    def stopped(command, **kwargs):
        assert command == ['docker', 'ps', '-q']
        return ''
    monkeypatch.setattr(installer.subprocess, 'check_output', stopped)
    with pytest.raises(RuntimeError, match='Previously initialized provider registry missing'):
        installer.install()
    control = Path(config['workspaces'][0]['engine']['restoreGuardDir'])
    assert not (control / 'provider-registry').exists()


def test_restored_run_uses_signed_provider_proof_and_corruption_stays_blocked(tmp_path):
    config = configuration(tmp_path)
    control = Path(config['workspaces'][0]['engine']['restoreGuardDir'])
    registry = ProviderRegistry.initialize(control / 'provider-registry', control / 'provider-registry.key', 'a', 'tenant-a')
    registry.start_run('run-a', 'digest', 'configuration', {'consumed_at': 'time'})
    assert verify(config)['valid']
    attempt = registry.claim('run-a', 'slot', {'text_sha256': 'text'})
    data = tmp_path / 'data'
    file = data / 'a/state/gate/workspaces/a/runs/run-a.json'
    file.parent.mkdir(parents=True)
    file.write_text(json.dumps({'workspace_id': 'a', 'run_id': 'run-a', 'request_digest': 'digest',
        'context': {'configuration_identity': 'configuration'}, 'status': 'approved', 'approval': {'consumed_at': None}}))
    import shutil
    backup = tmp_path / 'backup'
    shutil.copytree(data, backup)
    records = registry.records()
    result = restore(config, backup, hashes(backup))
    assert len(result['provider_snapshots']) == 1
    assert registry.records() == records
    assert audit(config)['runs'][0]['decision'] == 'provider_reservation_unknown_keep_blocked'
    registry.received(attempt, b'audio', {'request-id': 'request'})
    result = audit(config)
    assert result['runs'][0]['decision'] == 'provider_responses_preserved_do_not_replay'
    assert not result['runs'][0]['execution_allowed']
    import sqlite3
    with sqlite3.connect(registry.database) as db:
        db.execute('DELETE FROM records')
    result = audit(config)
    assert result['issues'][0]['reason'] == 'provider_registry_invalid'
    assert not result['runs'][0]['execution_allowed']
    assert not verify(config)['valid']
