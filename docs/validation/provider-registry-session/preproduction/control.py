"""Operate the localhost-only simulated service without loading account credentials."""
import json
import hashlib
import os
from pathlib import Path
import subprocess
import sys
if __name__ == '__main__' and (not sys.flags.isolated or not sys.dont_write_bytecode
        or (Path(__file__).resolve().parent / '__pycache__').exists()
        or list(Path(__file__).resolve().parent.glob('*.pyc'))):
    raise RuntimeError('Operator runtime requires Python 3.12 with -I -B and no operator bytecode cache')
import time
import urllib.request
sys.path.insert(0, str(Path(__file__).resolve().parent))
from operator_runtime import operator_python
from node_runtime import pinned_node
from api_authority import operator_lock
from recover_owner import checked, recover

HERE = Path(__file__).resolve().parent

def status():
    config = json.loads((HERE / 'config.json').read_text())
    assert config['host'] == '127.0.0.1' and config['provider'] == 'simulated'
    with urllib.request.urlopen(f"http://127.0.0.1:{config['healthPort']}/healthz", timeout=15) as response:
        value = json.load(response)
    assert value['provider'] == 'simulated' and value['api'] == f"http://127.0.0.1:{config['apiPort']}"
    return value

action = sys.argv[1] if len(sys.argv) == 2 else 'status'
automatic = len(sys.argv) == 3 and sys.argv[1:] == ['start', '--automatic']
if automatic:
    action = 'start'
paused = HERE / 'supervisor.pause'
if action == 'start':
    config_bytes = (HERE / 'config.json').read_bytes()
    config_hash = hashlib.sha256(config_bytes).hexdigest()
    config = json.loads(config_bytes)
    interpreter = operator_python(config)
    runtime = json.loads((HERE / 'boot-runtime.json').read_text())
    node = pinned_node(runtime['node'])
    if os.name == 'nt' and not config.get('windowsApiRoot'):
        raise RuntimeError('Windows API requires a qualified AppContainer; no unrestricted fallback')
    assert config['host'] == '127.0.0.1' and config['provider'] == 'simulated'
    # Kernel lock releases on supervisor death; serialize recovery and startup.
    checked(HERE / 'startup.lock')
    with operator_lock(HERE, 'startup.lock', 1):
        if automatic and paused.exists():
            raise SystemExit(0)
        preflight = [interpreter, '-I', '-B', str(HERE / 'financial_preflight.py'),
                     '--expected-config-sha256', config_hash]
        subprocess.run(preflight, check=True, capture_output=True, timeout=15)
        recovery = recover(config)
        subprocess.run(preflight, check=True, capture_output=True, timeout=15)
        flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP if os.name == 'nt' else 0
        with (HERE / 'service.log').open('ab') as log:
            command = ([interpreter, '-I', '-B', str(HERE / 'api_supervisor.py'), config_hash]
                if os.name == 'nt' else [node, str(HERE / 'service.mjs'), str(HERE / 'config.json'), config_hash])
            child = subprocess.Popen(command,
                cwd=HERE, stdin=subprocess.DEVNULL, stdout=log, stderr=log, creationflags=flags)
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            assert child.poll() is None, 'Startup failed; inspect service.log'
            try:
                result = status()
                if os.name == 'nt':
                    owner = json.loads((HERE / 'native-owner.json').read_text())
                    assert owner['supervisorPid'] == child.pid and result['pid'] == owner['apiPid']
                    assert result['proxyPid'] == owner['proxyPid']
                else:
                    assert result['pid'] == child.pid
                print(json.dumps(result))
                if recovery['recovered']:
                    print(json.dumps(recovery))
                if not automatic:
                    paused.unlink(missing_ok=True)
                break
            except OSError:
                time.sleep(.2)
        else:
            raise RuntimeError('Startup health timeout')
elif action == 'stop':
    current = status()
    paused.write_text('intentional stop; explicit start resumes supervision')
    (HERE / 'stop.request').write_text('graceful stop')
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        try:
            assert status()['pid'] == current['pid']
        except OSError:
            queue = Path(json.loads((HERE / 'config.json').read_text())['jobQueue']['dataDir'])
            if not (queue / 'owner.lock').exists():
                print('{"status":"stopped"}')
                break
        time.sleep(.2)
    else:
        raise RuntimeError('Graceful stop timeout; engine or operation may still be active')
elif action == 'status':
    print(json.dumps(status()))
else:
    raise SystemExit('Use start, stop or status')
