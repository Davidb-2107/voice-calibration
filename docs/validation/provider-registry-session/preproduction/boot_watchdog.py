"""Scheduled-task entrypoint with declared runtimes and no operation replay."""
import json
import os
from pathlib import Path
import subprocess
import sys
if __name__ == '__main__' and (not sys.flags.isolated or not sys.dont_write_bytecode
        or (Path(__file__).resolve().parent / '__pycache__').exists()
        or list(Path(__file__).resolve().parent.glob('*.pyc'))):
    raise RuntimeError('Operator runtime requires Python 3.12 with -I -B and no operator bytecode cache')
sys.path.insert(0, str(Path(__file__).resolve().parent))
from operator_runtime import operator_python
from node_runtime import pinned_node

HERE = Path(__file__).resolve().parent

def environment(root):
    config = json.loads((root / 'config.json').read_text())
    interpreter = operator_python(config)
    if config['host'] != '127.0.0.1' or config['provider'] != 'simulated':
        raise RuntimeError('Boot supervision is limited to local simulated preproduction')
    runtime = json.loads((root / 'boot-runtime.json').read_text())
    pinned_node(runtime['node'])
    directories = []
    for name in ('python', 'node', 'docker'):
        executable = Path(runtime[name])
        if not executable.is_absolute() or not executable.is_file():
            raise RuntimeError('Declared boot runtime unavailable: ' + name)
        directories.append(str(executable.parent))
    if Path(runtime['python']).resolve() != Path(interpreter).resolve():
        raise RuntimeError('Unexpected Python boot runtime')
    return {**os.environ, 'PATH': os.pathsep.join([*directories, os.environ.get('PATH', '')]),
            'DOCKER_CONFIG': runtime['dockerConfig']}

def main(root):
    env = environment(root)
    config = json.loads((root / 'config.json').read_text())
    locks = []
    guard = None
    if config.get('windowsApiRoot'):
        from windows_api_candidate import WindowsApiCandidate
        from api_authority import verify
        guard = WindowsApiCandidate.open(Path(config['windowsApiRoot']))
        try:
            verify(guard, locks)
        except BaseException:
            for handle in locks:
                guard._api.kernel.CloseHandle(handle)
            raise
    flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
    try:
        with (root / 'watchdog.log').open('ab') as log:
            return subprocess.call([sys.executable, '-I', '-B', str(root / 'watchdog.py')], cwd=root,
                env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log, creationflags=flags)
    finally:
        for handle in locks:
            guard._api.kernel.CloseHandle(handle)

if __name__ == '__main__':
    raise SystemExit(main(HERE))
