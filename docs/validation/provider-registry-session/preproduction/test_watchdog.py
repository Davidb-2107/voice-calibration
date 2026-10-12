import io
import json
from pathlib import Path
import subprocess
import pytest
import watchdog

@pytest.fixture
def root(tmp_path):
    (tmp_path / 'queue').mkdir()
    (tmp_path / 'queue/owner.lock').write_text('{"pid":123}')
    (tmp_path / 'config.json').write_text(json.dumps({'host': '127.0.0.1', 'provider': 'simulated',
        'healthPort': 4328, 'apiPort': 4327, 'commit': 'fixed', 'jobQueue': {'dataDir': str(tmp_path / 'queue')}}))
    return tmp_path

def test_intentional_stop_does_not_restart(root, monkeypatch):
    (root / 'supervisor.pause').write_text('maintenance')
    monkeypatch.setattr(subprocess, 'run', lambda *a, **k: pytest.fail('unexpected restart'))
    assert watchdog.tick(root) == 'paused'

def test_matching_healthy_service_does_not_restart(root, monkeypatch):
    health = {'status': 'ready', 'provider': 'simulated', 'pid': 123, 'commit': 'fixed',
              'api': 'http://127.0.0.1:4327', 'providerRegistry': {'valid': True}}
    monkeypatch.setattr(watchdog.urllib.request, 'urlopen', lambda *a, **k: io.BytesIO(json.dumps(health).encode()))
    monkeypatch.setattr(subprocess, 'run', lambda *a, **k: pytest.fail('unexpected restart'))
    assert watchdog.tick(root) == 'healthy'

@pytest.mark.parametrize('exit_code, expected', [(0, 'restarted'), (1, 'blocked')])
def test_dead_or_unhealthy_service_uses_safe_controller(root, monkeypatch, exit_code, expected):
    def unavailable(*a, **k):
        raise OSError('unavailable')
    monkeypatch.setattr(watchdog.urllib.request, 'urlopen', unavailable)
    calls = []
    def run(args, **kwargs):
        calls.append(args)
        return subprocess.CompletedProcess(args, exit_code)
    monkeypatch.setattr(subprocess, 'run', run)
    assert watchdog.tick(root) == expected
    assert calls[0][-2:] == ['start', '--automatic']

def test_foreign_health_cannot_mask_queue_owner(root, monkeypatch):
    health = {'status': 'ready', 'provider': 'simulated', 'pid': 999, 'commit': 'fixed',
              'api': 'http://127.0.0.1:4327', 'providerRegistry': {'valid': True}}
    monkeypatch.setattr(watchdog.urllib.request, 'urlopen', lambda *a, **k: io.BytesIO(json.dumps(health).encode()))
    monkeypatch.setattr(subprocess, 'run', lambda args, **k: subprocess.CompletedProcess(args, 1))
    assert watchdog.tick(root) == 'blocked'

@pytest.mark.parametrize('error', [OSError('runtime unavailable'), subprocess.TimeoutExpired('control', 90)])
def test_controller_failure_keeps_watchdog_available(root, monkeypatch, error):
    monkeypatch.setattr(watchdog.urllib.request, 'urlopen', lambda *a, **k: io.BytesIO(b'{}'))
    def run(*a, **k):
        raise error
    monkeypatch.setattr(subprocess, 'run', run)
    assert watchdog.tick(root) == 'blocked'
