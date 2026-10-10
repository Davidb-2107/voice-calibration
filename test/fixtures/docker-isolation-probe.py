"""Adversarial checks against disposable sentinels inside the engine container."""
import errno
import json
import os
from pathlib import Path
import socket
import sys

suffix = sys.argv[1]
assert suffix in ('a', 'b')
other = 'b' if suffix == 'a' else 'a'
root = Path('/workspace')
own = root / f'private-{suffix}.txt'
own.write_text('own-write-ok')
link = root / 'foreign-link'
link.symlink_to(root / '..' / other / f'private-{other}.txt')
try:
    link.read_text()
except FileNotFoundError:
    symlink_denied = True
else:
    raise AssertionError('Sibling sentinel accessible through symlink')
try:
    Path('/rootfs-write-sentinel').write_text('forbidden')
except OSError as error:
    assert error.errno in (errno.EROFS, errno.EACCES)
else:
    raise AssertionError('Rootfs write unexpectedly allowed')
with socket.socket() as connection:
    connection.settimeout(0.2)
    assert connection.connect_ex(('198.51.100.1', 443)) != 0
print(json.dumps({'ownWrite': own.read_text() == 'own-write-ok',
    'foreignVisible': (root / f'private-{other}.txt').exists(),
    'parentSecret': bool(os.environ.get('SUPABASE_SERVICE_ROLE_KEY')),
    'ownCredential': os.environ.get('ELEVENLABS_API_KEY') == f'provider-{suffix}-sentinel',
    'uid': os.getuid(), 'symlinkDenied': symlink_denied, 'rootWriteDenied': True, 'egressDenied': True}))
