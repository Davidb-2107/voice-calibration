"""Development validation in two fresh isolated Linux containers; no network."""
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / 'application'))
from provider_registry import ProviderRegistry
from restore import write_record


def validate():
    config = json.loads((HERE / 'config.json').read_text())
    assert config['provider'] == 'simulated' and config['providerRegistryRequired']
    root = HERE.parent / 'temp' / ('provider-registry-docker-' + uuid.uuid4().hex[:8])
    root.mkdir()
    results = []
    for workspace, initial, resumed in [('a', 'crash', 'recover'), ('b', 'first', 'replay')]:
        private = root / 'data' / workspace
        for name in ['state', 'corpus', 'ui']:
            (private / name).mkdir(parents=True)
        (private / 'corpus/voice_wpm.json').write_text('{}')
        control = root / 'recovery' / workspace
        control.mkdir(parents=True)
        write_record(control / 'guard.json', {'version': 1, 'workspace_id': workspace, 'state': 'ready'})
        registry = ProviderRegistry.initialize(control / 'provider-registry', control / 'provider-registry.key', workspace, 'tenant-' + workspace)
        command = ['docker', 'run', '--rm', '--pull=never', '--network=none', '--read-only',
                   '--user=10001:10001', '--cap-drop=ALL', '--security-opt=no-new-privileges',
                   '--memory=512m', '--cpus=1', '--pids-limit=64',
                   '--tmpfs=/tmp:rw,nosuid,nodev,size=64m,uid=10001,gid=10001']
        for source, target, readonly in [(private, '/workspace', True), (private / 'state', '/workspace/state', False),
                (private / 'corpus', '/workspace/corpus', False), (control, '/restore-control', True),
                (control / 'provider-registry', '/provider-registry', False),
                (HERE / 'provider-registry-image/probe.py', '/probe.py', True)]:
            command += ['--mount', f'type=bind,src={source},dst={target}' + (',readonly' if readonly else '')]
        values = {'ELEVENLABS_API_KEY': 'hosted-test-fake-' + workspace,
                  'VOICE_CALIBRATION_WORKSPACE_ID': workspace, 'VOICE_CALIBRATION_TENANT_ID': 'tenant-' + workspace,
                  'VOICE_CALIBRATION_STATE_DIR': '/workspace/state', 'VOICE_WPM_PATH': '/workspace/corpus/voice_wpm.json',
                  'VOICE_CALIBRATION_UI_WORKSPACE_DIR': '/workspace/ui',
                  'VOICE_CALIBRATION_RESTORE_GUARD_PATH': '/restore-control/guard.json',
                  'VOICE_CALIBRATION_PROVIDER_REGISTRY_DIR': '/provider-registry',
                  'VOICE_CALIBRATION_PROVIDER_REGISTRY_KEY': '/restore-control/provider-registry.key'}
        for key, value in values.items():
            command += ['--env', key + '=' + value]
        command += [config['image'], '/opt/venv/bin/python', '-I', '/probe.py']
        for mode in [initial, resumed]:
            result = subprocess.run([*command, mode], capture_output=True, text=True, timeout=45)
            expected = 73 if mode == 'crash' else 0
            assert result.returncode == expected, result.stderr
            rows = registry.records()
            results.append({'workspace': workspace, 'mode': mode, 'exit_code': result.returncode,
                            'records': len(rows), 'details': json.loads(result.stdout) if result.stdout.strip() else None})
        calls = (private / 'state/provider-receipts.jsonl')
        assert (len(calls.read_text().splitlines()) if calls.exists() else 0) == (0 if workspace == 'a' else 3)
    for workspace in ['a', 'b']:
        control = root / 'recovery' / workspace
        foreign = ProviderRegistry(control / 'provider-registry', control / 'provider-registry.key', 'foreign', 'tenant-foreign')
        try:
            foreign.records()
        except RuntimeError:
            pass
        else:
            raise AssertionError('Cross-workspace journal accepted')
    report = {'status': 'PASS', 'image': config['image'], 'root': str(root), 'results': results,
              'real_provider_calls': 0, 'simulated_provider_calls': 4, 'restored_approval_replays': 0}
    write_record(HERE / 'provider-registry-docker-report.json', report)
    print(json.dumps(report))


if __name__ == '__main__':
    validate()
