"""Bind an isolated MCP transport to a separately qualified, trusted SDK authority.

The SDK retains its existing public MCP interface and financial validations.
No key, SQL callback or generic signature operation crosses to the transport.
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import operator_runtime  # Refuse unsupported Python before business imports.

import argparse
import hashlib
import hmac
import json
import os
import subprocess
import threading

from windows_candidate import WindowsCandidate, _canonical


class WindowsMcpCandidate(WindowsCandidate):
    def qualify(self, argv, env=None, *, sdk_root, authority_env):
        sdk = WindowsCandidate.open(sdk_root)
        payload = sdk._load_payload()
        if Path(payload['argv'][0]).name.lower() != 'python.exe':
            raise RuntimeError('MCP authority requires its qualified Python command')
        if (not isinstance(authority_env, dict)
                or any(not isinstance(key, str) or not isinstance(value, str)
                       or not (key.startswith('VOICE_') or key == 'ELEVENLABS_API_KEY')
                       or '\0' in key+value for key, value in authority_env.items())):
            raise RuntimeError('Invalid bound MCP authority environment')
        key = Path(authority_env.get('VOICE_CALIBRATION_PROVIDER_REGISTRY_KEY', ''))
        if (not key.is_absolute() or not key.is_file()
                or key.resolve().is_relative_to(self.code) or key.resolve().is_relative_to(self.state)):
            raise RuntimeError('Provider key must be outside isolated writable data and code')
        keys = [str(self.authority_key), str(sdk.authority_key), str(key)]
        if env:
            raise RuntimeError('Isolated MCP transport takes no business environment')
        super().qualify(argv, {'VOICE_MCP_AUTHORITY_KEYS': json.dumps(keys),
                              'VOICE_MCP_AUTHORITY_CODE': payload['argv'][-1]})
        record = json.loads(self._manifest.read_text(encoding='utf-8'))
        record['payload']['mcp_authority'] = {
            'sdk_root': str(sdk.root),
            'target_sha256': hashlib.sha256(sdk._manifest.read_bytes()).hexdigest(),
            'env': authority_env,
        }
        record['signature'] = hmac.new(self.authority_key.read_bytes(), _canonical(record['payload']), hashlib.sha256).hexdigest()
        self._manifest.write_text(json.dumps(record, indent=2)+'\n', encoding='utf-8')
        self._protect(self._manifest, 'authority')
        self._authority_security[str(self._manifest)] = self._api.security_descriptor(self._manifest)
        return record['signature']

    def _sdk(self, payload):
        config = payload['mcp_authority']
        sdk = WindowsCandidate.open(Path(config['sdk_root']))
        if hashlib.sha256(sdk._manifest.read_bytes()).hexdigest() != config['target_sha256']:
            raise RuntimeError('Bound SDK authority qualification changed')
        sdk_payload = sdk._load_payload()
        if Path(sdk_payload['argv'][0]).name.lower() != 'python.exe':
            raise RuntimeError('MCP authority requires its qualified Python command')
        expected = [str(self.authority_key), str(sdk.authority_key), str(Path(config['env']['VOICE_CALIBRATION_PROVIDER_REGISTRY_KEY']))]
        if json.loads(payload['env']['VOICE_MCP_AUTHORITY_KEYS']) != expected:
            raise RuntimeError('MCP authority keys and transport witnesses disagree')
        if payload['env']['VOICE_MCP_AUTHORITY_CODE'] != sdk_payload['argv'][-1]:
            raise RuntimeError('MCP authority code and transport witness disagree')
        allowed = {'SYSTEMROOT', 'WINDIR', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'ALLUSERSPROFILE', 'PROGRAMDATA'}
        environment = {key: value for key, value in sdk_payload['env'].items() if key in allowed}
        private_state = self._authority / 'runtime-state'
        private_state.mkdir(exist_ok=True)
        environment.update(PATH=str(sdk.code)+';'+str(Path(environment['SYSTEMROOT'])/'System32'),
                           TEMP=str(private_state), TMP=str(private_state))
        environment.update(config['env'])
        return sdk, sdk_payload, environment

    def run(self, source, destination, errors):
        self._check_authority()
        payload = self._load_payload()
        sdk, sdk_payload, environment = self._sdk(payload)
        locks = []
        backend = None
        try:
            if sdk._snapshot(locks) != sdk_payload['code']:
                raise RuntimeError('Qualified MCP SDK code or protection changed')
            with self.start() as worker:
                ready = json.loads(worker.stdout.readline())
                if (ready.get('kind') != 'isolated-mcp-ready-v1' or ready.get('pid') != worker.pid
                        or len(ready.get('keys', [])) != 3
                        or ready.get('code') != {'write_denied': True, 'acl_denied': True}
                        or ready.get('sdk_code') != {'write_denied': True, 'acl_denied': True}
                        or not all(item == {'read_denied': True, 'write_denied': True, 'acl_denied': True}
                                   for item in ready['keys'])):
                    raise RuntimeError('MCP authority-key isolation was not established')
                backend = subprocess.Popen(sdk_payload['argv'], env=environment, cwd=self._authority / 'runtime-state',
                                           stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                           close_fds=True)
                try:
                    # The shared job controls lifetime, not token identity or authority.
                    self._api.check(self._api.kernel.AssignProcessToJobObject(worker._job, int(backend._handle)))
                    identity = self._api.identity(int(backend._handle))
                    if identity != self.authority_identity or identity['is_appcontainer']:
                        raise RuntimeError('SDK authority has the wrong effective identity')
                    session = {'worker_pid': worker.pid, 'worker_identity': worker.identity,
                               'sdk_pid': backend.pid, 'sdk_identity': identity,
                               'sdk_argv': sdk_payload['argv'], 'ready': ready}
                    (self._authority / 'mcp-session.json').write_text(json.dumps(session, indent=2)+'\n', encoding='utf-8')

                    def relay(origin, target, close=False):
                        try:
                            while data := os.read(origin.fileno(), 65536):
                                target.write(data)
                                target.flush()
                        except (BrokenPipeError, OSError, ValueError):
                            pass  # Closure propagates through EOF and the owned job.
                        finally:
                            if close:
                                target.close()

                    routes = [(source, worker.stdin, True), (worker.stdout, backend.stdin, True),
                              (backend.stdout, destination, False), (backend.stderr, errors, False),
                              (worker.stderr, errors, False)]
                    threads = [threading.Thread(target=relay, args=route, daemon=True) for route in routes]
                    for thread in threads:
                        thread.start()
                    result = backend.wait()
                    worker_result = worker.wait(5)
                    for thread in threads[1:]:
                        thread.join(5)
                        if thread.is_alive():
                            raise RuntimeError('MCP output did not close')
                    return result or worker_result
                finally:
                    if backend.poll() is None:
                        backend.terminate()
                        backend.wait(5)
                    for stream in (backend.stdin, backend.stdout, backend.stderr):
                        stream.close()
        finally:
            for handle in locks:
                self._api.kernel.CloseHandle(handle)


def main():
    parser = argparse.ArgumentParser(description='Run the qualified isolated MCP and its SDK authority')
    parser.add_argument('operation', choices=['run'])
    parser.add_argument('root', type=Path)
    arguments = parser.parse_args()
    try:
        candidate = WindowsMcpCandidate.open(arguments.root)
        return candidate.run(sys.stdin.buffer, sys.stdout.buffer, sys.stderr.buffer)
    except (OSError, RuntimeError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
