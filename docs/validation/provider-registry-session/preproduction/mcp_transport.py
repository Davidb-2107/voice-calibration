"""Pre-import isolation witnesses, then the real SDK in this same process."""
import sys
if sys.version_info[:3] != (3, 12, 10):
    raise SystemExit('Qualified MCP transport requires Python 3.12.10')
for stream in (sys.stdin, sys.stdout, sys.stderr):
    stream.reconfigure(encoding='utf-8')

import ctypes as c
from ctypes import wintypes as w
import json
import os
from pathlib import Path


def sdk_source_only():
    """Compile our SDK source in memory; retain sealed vendor dependency caches."""
    from importlib.abc import MetaPathFinder
    from importlib.machinery import PathFinder, SourceFileLoader
    root = Path(__file__).resolve().parent / 'runtime/Lib/site-packages/voice_calibration'
    class Loader(SourceFileLoader):
        def get_code(self, fullname):
            filename = self.get_filename(fullname)
            return self.source_to_code(self.get_data(filename), filename)
    class Finder(MetaPathFinder):
        def find_spec(self, fullname, path=None, target=None):
            if fullname != 'voice_calibration' and not fullname.startswith('voice_calibration.'):
                return None
            spec = PathFinder.find_spec(fullname, path)
            if (spec is None or not isinstance(spec.loader, SourceFileLoader)
                    or not Path(spec.origin).resolve().is_relative_to(root)):
                raise ImportError('SDK must load from qualified source')
            spec.loader = Loader(fullname, spec.origin)
            return spec
    sys.meta_path.insert(0, Finder())


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
                      'runtime': code_probe(sys.executable),
                      'python': sys.executable, 'version': list(sys.version_info[:3])}), flush=True)
    if sys.stdin.buffer.readline() != b'@p03-start-v1\n':
        raise RuntimeError('MCP parent did not authorize business imports')
    sdk_source_only()
    from voice_calibration.core.authority_client import install_stdio
    install_stdio()
    from voice_calibration.mcp_server.server import main as sdk_main
    sdk_main()


if __name__ == '__main__':
    try:
        if len(sys.argv) == 3 and sys.argv[1] == 'authority':
            # This finite dispatcher never imports the MCP server.
            sdk_source_only()
            from voice_calibration.core.registry_authority import serve
            serve(sys.argv[2])
        elif len(sys.argv) == 1:
            main()
        else:
            raise RuntimeError('Unsupported MCP bootstrap command')
    except (OSError, RuntimeError, ValueError, KeyError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
