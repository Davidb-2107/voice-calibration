"""Isolated MCP byte transport. No SDK, provider credential or signing primitive."""
import sys
if sys.version_info[:3] != (3, 12, 10):
    raise SystemExit('Qualified MCP transport requires Python 3.12.10')

import ctypes as c
from ctypes import wintypes as w
import json
import os


def denied(path, access, allowed_errors=(5,)):
    kernel = c.WinDLL('kernel32', use_last_error=True)
    kernel.CreateFileW.argtypes = [w.LPCWSTR, w.DWORD, w.DWORD, c.c_void_p, w.DWORD, w.DWORD, w.HANDLE]
    kernel.CreateFileW.restype = w.HANDLE
    kernel.CloseHandle.argtypes = [w.HANDLE]
    handle = kernel.CreateFileW(path, access, 7, None, 3, 0, None)
    if handle != w.HANDLE(-1).value:
        kernel.CloseHandle(handle)
        raise RuntimeError('Isolated MCP can access a protected authority path')
    if c.get_last_error() not in allowed_errors:
        raise RuntimeError('Protected authority access was not explicitly denied')
    return True


def main():
    keys = json.loads(os.environ['VOICE_MCP_AUTHORITY_KEYS'])
    if not isinstance(keys, list) or len(keys) != 3 or any(not isinstance(path, str) for path in keys):
        raise RuntimeError('Three bound authority-key witnesses required')
    probes = [{'read_denied': denied(path, 0x80000000),
               'write_denied': denied(path, 0x40000000),
               'acl_denied': denied(path, 0x40000)} for path in keys]
    def code_probe(path):
        return {'write_denied': denied(path, 0x40000000, (5, 32)),
                'acl_denied': denied(path, 0x40000)}
    print(json.dumps({'kind': 'isolated-mcp-ready-v1', 'pid': os.getpid(), 'keys': probes,
                      'code': code_probe(__file__),
                      'sdk_code': code_probe(os.environ['VOICE_MCP_AUTHORITY_CODE']),
                      'python': sys.executable, 'version': list(sys.version_info[:3])}), flush=True)
    while data := os.read(sys.stdin.fileno(), 65536):
        pending = memoryview(data)
        while pending:
            written = os.write(sys.stdout.fileno(), pending)
            if not written:
                raise BrokenPipeError('MCP authority closed')
            pending = pending[written:]


if __name__ == '__main__':
    try:
        main()
    except (OSError, RuntimeError, ValueError, KeyError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
