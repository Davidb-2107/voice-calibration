"""Native API owner. All business startup follows verified, locked independent programs."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import threading

HERE = Path(__file__).resolve().parent
if not sys.flags.isolated or not sys.dont_write_bytecode:
    raise RuntimeError('API supervisor requires the fixed Python 3.12 interpreter with -I -B')
if (HERE / '__pycache__').exists() or list(HERE.glob('*.pyc')):
    raise RuntimeError('Operator bytecode caches are forbidden; qualified SDK caches only')
sys.path.insert(0, str(HERE))
from operator_runtime import operator_python
from node_runtime import pinned_node
from windows_api_candidate import WindowsApiCandidate
from api_authority import verify


def main():
    config_bytes = (HERE / 'config.json').read_bytes()
    config = json.loads(config_bytes)
    operator_python(config)
    expected = hashlib.sha256(config_bytes).hexdigest()
    if sys.argv[1:] != [expected]:
        raise RuntimeError('Independent API configuration changed')
    guard = WindowsApiCandidate.open(Path(config['windowsApiRoot']))
    payload = guard._load_payload()
    public = json.loads((guard.code / 'api-public.json').read_text(encoding='utf-8'))
    if public['controlConfigSha256'] != expected:
        raise RuntimeError('API qualification does not bind this controller configuration')
    locks = []
    broker = None
    try:
        verify(guard, locks)
        node = pinned_node(payload['argv'][0])
        with guard.start() as api:
            allowed = {'SYSTEMROOT', 'WINDIR', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'ALLUSERSPROFILE',
                       'PROGRAMDATA', 'TEMP', 'TMP'}
            env = {key: value for key, value in os.environ.items() if key.upper() in allowed}
            runtime = json.loads((HERE / 'boot-runtime.json').read_text())
            if pinned_node(runtime['node']) != node:
                raise RuntimeError('Boot Node and API Node must be the same pinned executable')
            env['PATH'] = os.pathsep.join([str(Path(runtime['docker']).parent), str(Path(os.environ['SYSTEMROOT']) / 'System32')])
            env['DOCKER_CONFIG'] = runtime['dockerConfig']
            broker = subprocess.Popen([node, str(HERE / 'api_broker.mjs'), str(HERE / 'config.json'), expected, str(api.pid)],
                cwd=HERE, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                creationflags=subprocess.CREATE_NO_WINDOW)
            (HERE / 'native-owner.json').write_text(json.dumps({'supervisorPid': os.getpid(), 'apiPid': api.pid,
                'proxyPid': broker.pid, 'appcontainerSid': guard.appcontainer_sid}), encoding='utf-8')
            def relay(source, destination):
                try:
                    while data := os.read(source.fileno(), 65536):
                        destination.write(data)
                        destination.flush()
                except (BrokenPipeError, OSError, ValueError):
                    pass
                finally:
                    if destination in (api.stdin, broker.stdin):
                        destination.close()
            routes = [(api.stdout, broker.stdin), (broker.stdout, api.stdin),
                      (api.stderr, sys.stderr.buffer), (broker.stderr, sys.stderr.buffer)]
            for route in routes:
                threading.Thread(target=relay, args=route, daemon=True).start()
            while api.returncode is None:
                if broker.poll() is not None:
                    if broker.returncode == 0:
                        api.wait(5)
                        break
                    api.kill()
                    raise RuntimeError('Independent API controller stopped')
                threading.Event().wait(.1)
            result = api.wait()
            try:
                broker.wait(timeout=15)
            except subprocess.TimeoutExpired:
                broker.terminate()
                broker.wait(timeout=5)
            return result
    finally:
        if broker is not None and broker.poll() is None:
            broker.terminate()
            broker.wait(timeout=5)
        for handle in locks:
            guard._api.kernel.CloseHandle(handle)


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (RuntimeError, OSError, ValueError, KeyError, TypeError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
