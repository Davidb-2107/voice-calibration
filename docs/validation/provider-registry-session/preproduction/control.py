"""Operate the localhost-only simulated service without loading account credentials."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.request

HERE = Path(__file__).resolve().parent

def status():
    with urllib.request.urlopen('http://127.0.0.1:4318/healthz', timeout=15) as response:
        value = json.load(response)
    assert value['provider'] == 'simulated' and value['api'] == 'http://127.0.0.1:4317'
    return value

action = sys.argv[1] if len(sys.argv) == 2 else 'status'
if action == 'start':
    config = json.loads((HERE / 'config.json').read_text())
    assert config['host'] == '127.0.0.1' and config['provider'] == 'simulated'
    assert not (Path(config['jobQueue']['dataDir']) / 'owner.lock').exists(), 'Existing owner lock: verify API and engines stopped before recovery'
    flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP if os.name == 'nt' else 0
    with (HERE / 'service.log').open('ab') as log:
        child = subprocess.Popen(['node', str(HERE / 'service.mjs'), str(HERE / 'config.json')],
            cwd=HERE, stdin=subprocess.DEVNULL, stdout=log, stderr=log, creationflags=flags)
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        assert child.poll() is None, 'Startup failed; inspect service.log'
        try:
            result = status()
            assert result['pid'] == child.pid
            print(json.dumps(result))
            break
        except OSError:
            time.sleep(.2)
    else:
        raise RuntimeError('Startup health timeout')
elif action == 'stop':
    current = status()
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
