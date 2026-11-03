"""Run the real MCP SDK in AppContainer, with a finite private authority channel."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import operator_runtime  # Refuse unsupported Python before business imports.

import argparse
import ctypes as c
from ctypes import wintypes as w
import hashlib
import hmac
import json
import os
import subprocess
import threading

from windows_candidate import (WindowsCandidate, RunningCandidate, _canonical,
                               _SecurityAttributes, _StartupEx, _ProcessInfo)

RPC_PREFIX = b'@p03-authority-v1:'
START = b'@p03-start-v1\n'
PUBLIC_ENV = {'VOICE_CALIBRATION_STATE_DIR', 'VOICE_CALIBRATION_WORKSPACE_ID',
              'VOICE_CALIBRATION_TENANT_ID', 'VOICE_WPM_PATH'}


def _write_all(stream, data):
    pending = memoryview(data)
    while pending:
        written = stream.write(pending)
        if not written:
            raise BrokenPipeError('MCP pipe closed')
        pending = pending[written:]
    stream.flush()


def _startup_json(process, timeout, errors, phase):
    values, failures = [], []
    def read():
        try:
            values.append(json.loads(process.stdout.readline()))
        except (OSError, ValueError) as error:
            failures.append(error)
    reader = threading.Thread(target=read, daemon=True)
    reader.start()
    reader.join(timeout)
    if reader.is_alive() or failures or not values:
        process._api.kernel.TerminateProcess(process._process, 1)
        process.wait(5)
        _write_all(errors, process.stderr.read())
        raise RuntimeError(phase+' startup handshake failed')
    return values[0]


def _spawn_authority(api, command, environment, cwd, job, expected_identity):
    """Create suspended, own in the existing job, verify, then resume."""
    import msvcrt
    handles, streams = [], []
    attributes = None
    info = _ProcessInfo()
    success = False
    try:
        pipes = []
        inherit = _SecurityAttributes(c.sizeof(_SecurityAttributes), None, True)
        for child_reads in (True, False, False):
            read, write = w.HANDLE(), w.HANDLE()
            api.check(api.kernel.CreatePipe(c.byref(read), c.byref(write), c.byref(inherit), 0))
            handles.extend((read.value, write.value))
            child, parent = (read.value, write.value) if child_reads else (write.value, read.value)
            api.check(api.kernel.SetHandleInformation(parent, 1, 0))
            pipes.append((child, parent))
        size = c.c_size_t()
        api.kernel.InitializeProcThreadAttributeList(None, 1, 0, c.byref(size))
        attributes = c.create_string_buffer(size.value)
        api.check(api.kernel.InitializeProcThreadAttributeList(attributes, 1, 0, c.byref(size)))
        inherited = (w.HANDLE * 3)(*(pair[0] for pair in pipes))
        api.check(api.kernel.UpdateProcThreadAttribute(attributes, 0, 0x20002,
                  inherited, c.sizeof(inherited), None, None))
        startup = _StartupEx()
        startup.startup.cb = c.sizeof(startup)
        startup.startup.flags = 0x100
        startup.startup.stdin, startup.startup.stdout, startup.startup.stderr = (pair[0] for pair in pipes)
        startup.attributes = c.cast(attributes, c.c_void_p)
        cmdline = c.create_unicode_buffer(subprocess.list2cmdline(command))
        block = c.create_unicode_buffer('\0'.join(key+'='+value for key, value in sorted(environment.items()))+'\0\0')
        api.check(api.kernel.CreateProcessW(command[0], cmdline, None, None, True,
                  0x80000 | 0x8000000 | 0x400 | 0x4, block, str(cwd),
                  c.byref(startup), c.byref(info)))
        api.check(api.kernel.AssignProcessToJobObject(job, info.process))
        identity = api.identity(info.process)
        if identity != expected_identity or identity['is_appcontainer']:
            raise RuntimeError('Finite authority has the wrong effective identity')
        for index, (child, parent) in enumerate(pipes):
            api.kernel.CloseHandle(child)
            handles.remove(child)
            descriptor = msvcrt.open_osfhandle(parent, os.O_BINARY | (os.O_WRONLY if index == 0 else os.O_RDONLY))
            handles.remove(parent)
            streams.append(os.fdopen(descriptor, 'wb' if index == 0 else 'rb', buffering=0))
        if api.kernel.ResumeThread(info.thread) != 1:
            raise RuntimeError('Finite authority was not safely suspended before resume')
        process = RunningCandidate(api, info.process, None, info.pid, identity, streams, [])
        success = True
        return process
    finally:
        if info.thread:
            api.kernel.CloseHandle(info.thread)
        if not success:
            if info.process:
                api.kernel.TerminateProcess(info.process, 1)
                api.kernel.WaitForSingleObject(info.process, 5000)
                api.kernel.CloseHandle(info.process)
            for stream in streams:
                stream.close()
        for handle in handles:
            api.kernel.CloseHandle(handle)
        if attributes:
            api.kernel.DeleteProcThreadAttributeList(attributes)


class WindowsMcpCandidate(WindowsCandidate):
    def qualify(self, argv, env=None, *, sdk_root, sdk_source, authority_env):
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
        sdk_code = self.code / 'runtime/Lib/site-packages/voice_calibration/mcp_server/server.py'
        if not sdk_code.is_file():
            raise RuntimeError('The actual SDK source must be inside qualified candidate code')
        runtime = self.code / 'runtime'
        package = runtime / 'Lib/site-packages/voice_calibration'
        def inventory(root, *, exclude_sdk=False):
            result = {}
            for path in root.rglob('*'):
                if path.is_symlink() or getattr(path, 'is_junction', lambda: False)():
                    raise RuntimeError('Linked SDK or runtime source is forbidden')
                if path.is_file() and not (exclude_sdk and path.is_relative_to(package)):
                    result[path.relative_to(root).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
            return result
        expected_runtime = {name.removeprefix('runtime/'): value['sha256']
                            for name, value in payload['code'].items()
                            if name.startswith('runtime/') and not value['directory']
                            and not name.startswith('runtime/Lib/site-packages/voice_calibration/')}
        if not expected_runtime or inventory(runtime, exclude_sdk=True) != expected_runtime:
            raise RuntimeError('Copied runtime or vendor dependency differs from qualified provenance')
        sources = inventory(Path(sdk_source))
        if (not sources or any(name.endswith(('.pyc', '.pyo', '.pyd', '.dll')) or '__pycache__' in name.split('/')
                               for name in sources)
                or inventory(package) != sources):
            raise RuntimeError('Candidate SDK differs from the reviewed source export')
        private_config = self._authority / 'authority-config.json'
        private_config.write_text(json.dumps({'environment': authority_env}, indent=2)+'\n', encoding='utf-8')
        self._protect(private_config, 'authority')
        self._authority_security[str(private_config)] = self._api.security_descriptor(private_config)
        public = {key: value for key, value in authority_env.items() if key in PUBLIC_ENV}
        public.update(VOICE_CALIBRATION_AUTHORITY='stdio-v1',
                      VOICE_MCP_AUTHORITY_KEYS=json.dumps(keys), VOICE_MCP_AUTHORITY_CODE=str(sdk_code))
        super().qualify(argv, public)
        record = json.loads(self._manifest.read_text(encoding='utf-8'))
        record['payload']['mcp_authority'] = {
            'schema': 'sdk-in-appcontainer-v2',
            'sdk_root': str(sdk.root),
            'target_sha256': hashlib.sha256(sdk._manifest.read_bytes()).hexdigest(),
            'env': authority_env,
            'config_sha256': hashlib.sha256(private_config.read_bytes()).hexdigest(),
            'sdk_sources': sources,
        }
        record['signature'] = hmac.new(self.authority_key.read_bytes(), _canonical(record['payload']), hashlib.sha256).hexdigest()
        self._manifest.write_text(json.dumps(record, indent=2)+'\n', encoding='utf-8')
        self._protect(self._manifest, 'authority')
        self._authority_security[str(self._manifest)] = self._api.security_descriptor(self._manifest)
        return record['signature']

    def _sdk(self, payload):
        config = payload['mcp_authority']
        if config.get('schema') != 'sdk-in-appcontainer-v2':
            raise RuntimeError('MCP relay-only qualification is not a business-isolation qualification')
        sdk = WindowsCandidate.open(Path(config['sdk_root']))
        if hashlib.sha256(sdk._manifest.read_bytes()).hexdigest() != config['target_sha256']:
            raise RuntimeError('Bound SDK authority qualification changed')
        sdk_payload = sdk._load_payload()
        if Path(sdk_payload['argv'][0]).name.lower() != 'python.exe':
            raise RuntimeError('MCP authority requires its qualified Python command')
        prefix = 'runtime/Lib/site-packages/voice_calibration/'
        sources = {name.removeprefix(prefix): value['sha256'] for name, value in payload['code'].items()
                   if name.startswith(prefix) and not value['directory']}
        copied = {name: value['sha256'] for name, value in payload['code'].items()
                  if name.startswith('runtime/') and not name.startswith(prefix) and not value['directory']}
        original = {name: value['sha256'] for name, value in sdk_payload['code'].items()
                    if name.startswith('runtime/') and not name.startswith(prefix) and not value['directory']}
        if sources != config['sdk_sources'] or copied != original:
            raise RuntimeError('Candidate SDK source or copied runtime provenance changed')
        expected = [str(self.authority_key), str(sdk.authority_key), str(Path(config['env']['VOICE_CALIBRATION_PROVIDER_REGISTRY_KEY']))]
        if json.loads(payload['env']['VOICE_MCP_AUTHORITY_KEYS']) != expected:
            raise RuntimeError('MCP authority keys and transport witnesses disagree')
        if payload['env']['VOICE_MCP_AUTHORITY_CODE'] != str(self.code / 'runtime/Lib/site-packages/voice_calibration/mcp_server/server.py'):
            raise RuntimeError('MCP authority code and transport witness disagree')
        allowed = {'SYSTEMROOT', 'WINDIR', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'ALLUSERSPROFILE', 'PROGRAMDATA'}
        environment = {key: value for key, value in sdk_payload['env'].items() if key in allowed}
        private_state = self._authority / 'runtime-state'
        private_state.mkdir(exist_ok=True)
        self._protect(private_state, 'authority')
        environment.update(PATH=str(self.code)+';'+str(Path(environment['SYSTEMROOT'])/'System32'),
                           TEMP=str(private_state), TMP=str(private_state))
        private_config = self._authority / 'authority-config.json'
        self._api.check_protection(private_config, self.authority_identity['user_sid'], None, 'authority')
        if (hashlib.sha256(private_config.read_bytes()).hexdigest() != config['config_sha256']
                or json.loads(private_config.read_bytes()) != {'environment': config['env']}):
            raise RuntimeError('Finite authority configuration binding changed')
        return environment

    def run(self, source, destination, errors):
        self._check_authority()
        payload = self._load_payload()
        locks = []
        try:
            locks.append(self._api.lock_file(self._authority / 'authority-config.json'))
            environment = self._sdk(payload)
            with self.start() as worker:
                # Bound the pre-import handshake; a broken bootstrap must not hang the client.
                ready = _startup_json(worker, 15, errors, 'Isolated MCP pre-import')
                if (not isinstance(ready, dict)
                        or ready.get('kind') != 'isolated-mcp-ready-v1' or ready.get('pid') != worker.pid
                        or ready.get('version') != [3, 12, 10]
                        or Path(ready.get('python', '')).resolve() != Path(payload['argv'][0]).resolve()
                        or len(ready.get('keys', [])) != 3
                        or ready.get('code') != {'write_denied': True, 'acl_denied': True}
                        or ready.get('runtime') != {'write_denied': True, 'acl_denied': True}
                        or ready.get('sdk_code') != {'write_denied': True, 'acl_denied': True}
                        or not all(item == {'read_denied': True, 'write_denied': True, 'acl_denied': True}
                                   for item in ready['keys'])):
                    raise RuntimeError('MCP authority-key isolation was not established')
                authority_command = payload['argv'] + ['authority', str(self._authority / 'authority-config.json')]
                backend = _spawn_authority(self._api, authority_command, environment,
                                           self._authority / 'runtime-state', worker._job, self.authority_identity)
                try:
                    _write_all(backend.stdin, b'{"id":1,"operation":"startup","arguments":{}}\n')
                    startup = _startup_json(backend, 30, errors, 'Finite authority')
                    if (not isinstance(startup, dict) or set(startup) != {'id', 'ok', 'value', 'error'}
                            or type(startup['id']) is not int or startup['id'] != 1
                            or startup['ok'] is not True or startup['error'] is not None
                            or not isinstance(startup['value'], dict)):
                        raise RuntimeError('Finite authority refused startup before SDK import')
                    scope = startup['value']
                    expected = payload['mcp_authority']['env']
                    if (scope.get('workspace_id') != expected['VOICE_CALIBRATION_WORKSPACE_ID']
                            or scope.get('tenant_id') != expected['VOICE_CALIBRATION_TENANT_ID']
                            or scope.get('financial_enabled') is not False or scope.get('execution_budget_ids') != []
                            or scope.get('dataset_admission') != json.loads(expected.get('VOICE_CALIBRATION_DATASET_ADMISSION', 'null'))):
                        raise RuntimeError('Finite authority startup scope or inactive state does not match')
                    session = {'worker_pid': worker.pid, 'worker_identity': worker.identity,
                               'sdk_pid': worker.pid, 'sdk_identity': worker.identity,
                               'sdk_argv': payload['argv'], 'authority_pid': backend.pid,
                               'authority_identity': backend.identity, 'authority_argv': authority_command,
                               'authority_role': 'finite-registry-finance', 'authority_startup': scope, 'ready': ready}
                    (self._authority / 'mcp-session.json').write_text(json.dumps(session, indent=2)+'\n', encoding='utf-8')
                    writer = threading.Lock()
                    failures = []
                    def write_worker(data):
                        with writer:
                            _write_all(worker.stdin, data)

                    def guarded(action):
                        try:
                            action()
                        except (BrokenPipeError, OSError, ValueError, RuntimeError, KeyError, TypeError) as error:
                            failures.append(error)
                            worker.kill()

                    def client_input():
                        try:
                            for line in source:
                                if line.lstrip().startswith((RPC_PREFIX, START.rstrip())):
                                    raise RuntimeError('Reserved authority messages are forbidden on the MCP client channel')
                                write_worker(line)
                        finally:
                            with writer:
                                worker.stdin.close()

                    def rpc():
                        # The authority channel has one synchronous request in flight.
                        for line in worker.stderr:
                            if not line.startswith(RPC_PREFIX):
                                errors.write(line)
                                errors.flush()
                                continue
                            request = json.loads(line[len(RPC_PREFIX):])
                            if (not isinstance(request, dict) or set(request) != {'id', 'operation', 'arguments'}
                                    or type(request['id']) is not int or request['id'] < 1
                                    or not isinstance(request['operation'], str) or not isinstance(request['arguments'], dict)):
                                raise RuntimeError('Malformed finite authority request')
                            _write_all(backend.stdin, json.dumps(request).encode()+b'\n')
                            answer = json.loads(backend.stdout.readline())
                            if (not isinstance(answer, dict) or type(answer.get('id')) is not int
                                    or answer.get('id') != request['id'] or type(answer.get('ok')) is not bool
                                    or set(answer) != {'id', 'ok', 'value', 'error'}
                                    or (answer['error'] is not None if answer['ok'] else answer['value'] is not None)):
                                raise RuntimeError('Finite authority response does not match the request')
                            write_worker(RPC_PREFIX+json.dumps(answer).encode()+b'\n')

                    def relay(origin, target):
                        try:
                            while data := os.read(origin.fileno(), 65536):
                                _write_all(target, data)
                        except (BrokenPipeError, OSError, ValueError):
                            pass  # Closure propagates through EOF and the owned job.

                    threads = [threading.Thread(target=guarded, args=(action,), daemon=True) for action in
                               (client_input, rpc, lambda: relay(worker.stdout, destination),
                                lambda: relay(backend.stderr, errors))]
                    write_worker(START)
                    for thread in threads:
                        thread.start()
                    if self._api.kernel.WaitForSingleObject(worker._process, 0xffffffff) != 0:
                        raise c.WinError(c.get_last_error())
                    # Let the finite authority release its independent lease before closing the shared job.
                    threads[1].join(5)
                    if threads[1].is_alive():
                        raise RuntimeError('MCP authority requests did not close')
                    backend.stdin.close()
                    authority_result = backend.wait(5)
                    worker_result = worker.wait(5)
                    for thread in threads[1:]:
                        thread.join(5)
                        if thread.is_alive():
                            raise RuntimeError('MCP output did not close')
                    if failures:
                        raise RuntimeError('MCP authority channel failed: '+str(failures[0])) from failures[0]
                    return worker_result or authority_result
                finally:
                    # The worker owns the shared job. Closing it kills its authority too.
                    if backend.returncode is None:
                        self._api.kernel.TerminateProcess(backend._process, 1)
                        backend.wait(5)
                    backend.close()
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
