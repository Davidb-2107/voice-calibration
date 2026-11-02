import json
from pathlib import Path
import sys
import pytest
from boot_watchdog import environment

def test_declared_runtime_environment(tmp_path,monkeypatch):
    # This unit checks environment composition. Native pinning has its own
    # real-executable refusal tests, rather than treating Python as Node.
    monkeypatch.setattr('boot_watchdog.pinned_node',lambda path:path)
    (tmp_path/'config.json').write_text(json.dumps({'host':'127.0.0.1','provider':'simulated','registryPython':sys.executable}))
    (tmp_path/'boot-runtime.json').write_text(json.dumps({
        'python':sys.executable,'node':sys.executable,'docker':sys.executable,'dockerConfig':str(tmp_path)}))
    env=environment(tmp_path)
    assert env['DOCKER_CONFIG']==str(tmp_path)
    assert env['PATH'].startswith(str(Path(sys.executable).parent))

@pytest.mark.parametrize('host,provider',[('0.0.0.0','simulated'),('127.0.0.1','elevenlabs')])
def test_external_or_paid_boot_refused(tmp_path,host,provider):
    (tmp_path/'config.json').write_text(json.dumps({'host':host,'provider':provider,'registryPython':sys.executable}))
    with pytest.raises(RuntimeError,match='local simulated'):
        environment(tmp_path)

def test_missing_runtime_blocks_boot(tmp_path,monkeypatch):
    monkeypatch.setattr('boot_watchdog.pinned_node',lambda path:path)
    (tmp_path/'config.json').write_text(json.dumps({'host':'127.0.0.1','provider':'simulated','registryPython':sys.executable}))
    (tmp_path/'boot-runtime.json').write_text(json.dumps({'python':str(tmp_path/'missing'),
        'node':sys.executable,'docker':sys.executable,'dockerConfig':str(tmp_path)}))
    with pytest.raises(RuntimeError,match='unavailable'):
        environment(tmp_path)
