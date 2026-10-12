"""External local supervisor: restart dead services, never replay operations."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.error
import urllib.request
from filelock import FileLock
from recover_owner import checked

HERE = Path(__file__).resolve().parent

def boot_id():
    if os.name != 'nt':
        return Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    import ctypes
    from ctypes import wintypes
    native = ctypes.WinDLL('ntdll')
    query = native.NtQuerySystemInformation
    query.argtypes = [wintypes.ULONG, ctypes.c_void_p, wintypes.ULONG, ctypes.POINTER(wintypes.ULONG)]
    info = ctypes.create_string_buffer(48)
    size = wintypes.ULONG()
    if query(3, info, len(info), ctypes.byref(size)) != 0:
        raise RuntimeError('Cannot establish Windows boot identity')
    return hex(int.from_bytes(info.raw[:8], 'little'))

def tick(root):
    if (root / 'supervisor.pause').exists():
        return 'paused'
    config = json.loads((root / 'config.json').read_text())
    if config['host'] != '127.0.0.1' or config['provider'] != 'simulated':
        raise RuntimeError('Watchdog is limited to the local simulated service')
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{config['healthPort']}/healthz", timeout=5) as response:
            health = json.load(response)
        owner = json.loads((Path(config['jobQueue']['dataDir']) / 'owner.lock').read_text())
        if (health['status'] == 'ready' and health['provider'] == 'simulated'
            and health['commit'] == config['commit'] and health['pid'] == owner['pid']
            and health['api'] == f"http://127.0.0.1:{config['apiPort']}"
            and health['providerRegistry']['valid']):
            return 'healthy'
    except (OSError, ValueError, KeyError, TypeError):
        pass
    # control.py proves death; an unhealthy but live owner is never killed.
    try:
        result = subprocess.run([sys.executable, str(root / 'control.py'), 'start', '--automatic'],
                                capture_output=True, text=True, timeout=90)
    except (OSError, subprocess.TimeoutExpired):
        return 'blocked'
    return 'restarted' if result.returncode == 0 else 'blocked'

def main(root):
    with FileLock(str(checked(root / 'watchdog.lock')), timeout=0):
        (root / 'watchdog.ready').write_text(json.dumps({'pid': os.getpid(), 'bootId': boot_id()}))
        while not (root / 'watchdog.stop').exists():
            state = tick(root)
            if state in ('restarted', 'blocked'):
                print(json.dumps({'supervisor': state}), flush=True)
            time.sleep(5 if state == 'blocked' else 2)
        (root / 'watchdog.stop').unlink(missing_ok=True)
        (root / 'watchdog.ready').unlink(missing_ok=True)

if __name__ == '__main__':
    main(HERE)
