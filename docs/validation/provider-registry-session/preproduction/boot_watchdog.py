"""Scheduled-task entrypoint with declared runtimes and no operation replay."""
import json
import os
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent

def environment(root):
    config = json.loads((root / 'config.json').read_text())
    if config['host'] != '127.0.0.1' or config['provider'] != 'simulated':
        raise RuntimeError('Boot supervision is limited to local simulated preproduction')
    runtime = json.loads((root / 'boot-runtime.json').read_text())
    directories = []
    for name in ('python', 'node', 'docker'):
        executable = Path(runtime[name])
        if not executable.is_absolute() or not executable.is_file():
            raise RuntimeError('Declared boot runtime unavailable: ' + name)
        directories.append(str(executable.parent))
    if Path(runtime['python']).resolve() != Path(sys.executable).resolve():
        raise RuntimeError('Unexpected Python boot runtime')
    return {**os.environ, 'PATH': os.pathsep.join([*directories, os.environ.get('PATH', '')]),
            'DOCKER_CONFIG': runtime['dockerConfig']}

def main(root):
    env = environment(root)
    flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
    with (root / 'watchdog.log').open('ab') as log:
        return subprocess.call([sys.executable, str(root / 'watchdog.py')], cwd=root,
            env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log, creationflags=flags)

if __name__ == '__main__':
    raise SystemExit(main(HERE))
