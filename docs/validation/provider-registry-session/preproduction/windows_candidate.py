"""Trusted, fixed-target Windows launcher. It never falls back to an ordinary token.

Only create disposable roots with this module. Creation adds a fresh per-app
AppContainer profile; existing files, profiles and installed ACLs are untouched.
The host account is shared, while the effective AppContainer identity is not.
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import operator_runtime  # Reject unsupported Python before business dependencies.

import ctypes as c
from ctypes import wintypes as w
from contextlib import contextmanager
import hashlib
import hmac
import json
import os
import stat
import subprocess
import threading
import time
import uuid


def _startup_trace(phase, event, error=None, candidate_pid=None):
    record = {'schema': 'windows-candidate-startup-v1', 'time_ns': time.time_ns(),
              'pid': os.getpid(), 'phase': phase, 'event': event}
    if candidate_pid is not None:
        record['candidate_pid'] = candidate_pid
    if error is not None:
        chain, seen = [], set()
        while error is not None and id(error) not in seen and len(chain) < 8:
            seen.add(id(error))
            winerror = getattr(error, 'winerror', None)
            chain.append({'type': type(error).__name__,
                          'winerror': winerror if type(winerror) is int else None})
            error = error.__cause__ if error.__cause__ is not None else (
                None if error.__suppress_context__ else error.__context__)
        record.update(error_chain=chain, chain_truncated=error is not None)
    try:
        # Messages, paths, arguments and environment values never enter this sink.
        print(json.dumps(record, separators=(',', ':')), file=sys.stderr, flush=True)
    except (OSError, ValueError):
        pass  # A closed diagnostic pipe must not change admission or process ownership.


@contextmanager
def _startup_phase(phase):
    _startup_trace(phase, 'begin')
    try:
        yield
    except BaseException as error:
        _startup_trace(phase, 'refused', error)
        raise
    else:
        _startup_trace(phase, 'passed')


class _Startup(c.Structure):
    _fields_ = [('cb', w.DWORD), ('reserved', w.LPWSTR), ('desktop', w.LPWSTR), ('title', w.LPWSTR),
                ('x', w.DWORD), ('y', w.DWORD), ('width', w.DWORD), ('height', w.DWORD),
                ('chars_x', w.DWORD), ('chars_y', w.DWORD), ('fill', w.DWORD), ('flags', w.DWORD),
                ('show', w.WORD), ('reserved_size', w.WORD), ('reserved_bytes', c.c_void_p),
                ('stdin', w.HANDLE), ('stdout', w.HANDLE), ('stderr', w.HANDLE)]


class _StartupEx(c.Structure):
    _fields_ = [('startup', _Startup), ('attributes', c.c_void_p)]


class _ProcessInfo(c.Structure):
    _fields_ = [('process', w.HANDLE), ('thread', w.HANDLE), ('pid', w.DWORD), ('tid', w.DWORD)]


class _Capabilities(c.Structure):
    _fields_ = [('sid', c.c_void_p), ('capabilities', c.c_void_p), ('count', w.DWORD), ('reserved', w.DWORD)]


class _SecurityAttributes(c.Structure):
    _fields_ = [('length', w.DWORD), ('descriptor', c.c_void_p), ('inherit', w.BOOL)]


class _SidAttributes(c.Structure):
    _fields_ = [('sid', c.c_void_p), ('attributes', w.DWORD)]


class _JobBasic(c.Structure):
    _fields_ = [('process_time', c.c_longlong), ('job_time', c.c_longlong), ('flags', w.DWORD),
                ('min_working', c.c_size_t), ('max_working', c.c_size_t), ('active', w.DWORD),
                ('affinity', c.c_size_t), ('priority', w.DWORD), ('scheduling', w.DWORD)]


class _JobLimits(c.Structure):
    _fields_ = [('basic', _JobBasic), ('io_counters', c.c_ulonglong * 6),
                ('process_memory', c.c_size_t), ('job_memory', c.c_size_t),
                ('peak_process_memory', c.c_size_t), ('peak_job_memory', c.c_size_t)]


class _StreamData(c.Structure):
    _fields_ = [('size', c.c_longlong), ('name', w.WCHAR * 296)]


class _Windows:
    def __init__(self):
        if os.name != 'nt':
            raise RuntimeError('Windows AppContainer is required')
        self.kernel = c.WinDLL('kernel32', use_last_error=True)
        self.security = c.WinDLL('advapi32', use_last_error=True)
        self.userenv = c.WinDLL('userenv', use_last_error=True)
        definitions = (
            (self.kernel, 'GetCurrentProcess', [], w.HANDLE),
            (self.kernel, 'CloseHandle', [w.HANDLE], w.BOOL),
            (self.kernel, 'LocalFree', [c.c_void_p], c.c_void_p),
            (self.kernel, 'CreateFileW', [w.LPCWSTR, w.DWORD, w.DWORD, c.c_void_p, w.DWORD, w.DWORD, w.HANDLE], w.HANDLE),
            (self.kernel, 'CreatePipe', [c.POINTER(w.HANDLE), c.POINTER(w.HANDLE), c.POINTER(_SecurityAttributes), w.DWORD], w.BOOL),
            (self.kernel, 'SetHandleInformation', [w.HANDLE, w.DWORD, w.DWORD], w.BOOL),
            (self.kernel, 'InitializeProcThreadAttributeList', [c.c_void_p, w.DWORD, w.DWORD, c.POINTER(c.c_size_t)], w.BOOL),
            (self.kernel, 'UpdateProcThreadAttribute', [c.c_void_p, w.DWORD, c.c_size_t, c.c_void_p, c.c_size_t, c.c_void_p, c.c_void_p], w.BOOL),
            (self.kernel, 'DeleteProcThreadAttributeList', [c.c_void_p], None),
            (self.kernel, 'CreateProcessW', [w.LPCWSTR, w.LPWSTR, c.c_void_p, c.c_void_p, w.BOOL, w.DWORD, c.c_void_p, w.LPCWSTR, c.c_void_p, c.POINTER(_ProcessInfo)], w.BOOL),
            (self.kernel, 'ResumeThread', [w.HANDLE], w.DWORD),
            (self.kernel, 'CreateJobObjectW', [c.c_void_p, w.LPCWSTR], w.HANDLE),
            (self.kernel, 'SetInformationJobObject', [w.HANDLE, c.c_int, c.c_void_p, w.DWORD], w.BOOL),
            (self.kernel, 'AssignProcessToJobObject', [w.HANDLE, w.HANDLE], w.BOOL),
            (self.kernel, 'TerminateJobObject', [w.HANDLE, w.UINT], w.BOOL),
            (self.kernel, 'TerminateProcess', [w.HANDLE, w.UINT], w.BOOL),
            (self.kernel, 'WaitForSingleObject', [w.HANDLE, w.DWORD], w.DWORD),
            (self.kernel, 'GetExitCodeProcess', [w.HANDLE, c.POINTER(w.DWORD)], w.BOOL),
            (self.kernel, 'FindFirstStreamW', [w.LPCWSTR, c.c_int, c.c_void_p, w.DWORD], w.HANDLE),
            (self.kernel, 'FindNextStreamW', [w.HANDLE, c.c_void_p], w.BOOL),
            (self.kernel, 'FindClose', [w.HANDLE], w.BOOL),
            (self.security, 'OpenProcessToken', [w.HANDLE, w.DWORD, c.POINTER(w.HANDLE)], w.BOOL),
            (self.security, 'GetTokenInformation', [w.HANDLE, c.c_int, c.c_void_p, w.DWORD, c.POINTER(w.DWORD)], w.BOOL),
            (self.security, 'ConvertSidToStringSidW', [c.c_void_p, c.POINTER(w.LPWSTR)], w.BOOL),
            (self.security, 'FreeSid', [c.c_void_p], c.c_void_p),
            (self.security, 'ConvertStringSecurityDescriptorToSecurityDescriptorW', [w.LPCWSTR, w.DWORD, c.POINTER(c.c_void_p), c.POINTER(w.DWORD)], w.BOOL),
            (self.security, 'ConvertSecurityDescriptorToStringSecurityDescriptorW', [c.c_void_p, w.DWORD, w.DWORD, c.POINTER(w.LPWSTR), c.POINTER(w.DWORD)], w.BOOL),
            (self.security, 'SetFileSecurityW', [w.LPCWSTR, w.DWORD, c.c_void_p], w.BOOL),
            (self.security, 'GetFileSecurityW', [w.LPCWSTR, w.DWORD, c.c_void_p, w.DWORD, c.POINTER(w.DWORD)], w.BOOL),
            (self.userenv, 'CreateAppContainerProfile', [w.LPCWSTR, w.LPCWSTR, w.LPCWSTR, c.c_void_p, w.DWORD, c.POINTER(c.c_void_p)], w.LONG),
            (self.userenv, 'DeriveAppContainerSidFromAppContainerName', [w.LPCWSTR, c.POINTER(c.c_void_p)], w.LONG),
        )
        for library, name, arguments, result in definitions:
            function = getattr(library, name)
            function.argtypes, function.restype = arguments, result

    @staticmethod
    def check(result):
        if not result:
            raise c.WinError(c.get_last_error())
        return result

    def sid_text(self, sid):
        output = w.LPWSTR()
        self.check(self.security.ConvertSidToStringSidW(sid, c.byref(output)))
        try:
            return output.value
        finally:
            self.kernel.LocalFree(output)

    def identity(self, process=None):
        token = w.HANDLE()
        self.check(self.security.OpenProcessToken(process or self.kernel.GetCurrentProcess(), 0x8, c.byref(token)))
        def info(kind):
            size = w.DWORD()
            self.security.GetTokenInformation(token, kind, None, 0, c.byref(size))
            buffer = c.create_string_buffer(size.value)
            self.check(self.security.GetTokenInformation(token, kind, buffer, size, c.byref(size)))
            return buffer
        try:
            user, integrity, app, capabilities = info(1), info(25), info(31), info(30)
            app_sid = c.c_void_p.from_buffer(app).value
            return {'user_sid': self.sid_text(_SidAttributes.from_buffer(user).sid),
                    'integrity_sid': self.sid_text(_SidAttributes.from_buffer(integrity).sid),
                    'is_appcontainer': bool(w.DWORD.from_buffer(info(29)).value),
                    'appcontainer_sid': self.sid_text(app_sid) if app_sid else None,
                    'capability_count': w.DWORD.from_buffer(capabilities).value}
        finally:
            self.kernel.CloseHandle(token)

    @staticmethod
    def protection(user, app, role):
        descriptor = f'D:P(A;OICI;FA;;;{user})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'
        if role != 'authority':
            access = '0x1301bf' if role == 'state' else '0x1200a9'
            descriptor += f'(A;OICI;{access};;;{app})'
        descriptor += 'S:(ML;OICI;NW;;;LW)' if role == 'state' else (
            'S:(ML;OICI;NWNR;;;ME)' if role == 'authority' else 'S:(ML;OICI;NW;;;ME)')
        return descriptor

    def protect(self, path, user, app, role):
        descriptor = self.protection(user, app, role)
        native = c.c_void_p()
        self.check(self.security.ConvertStringSecurityDescriptorToSecurityDescriptorW(descriptor, 1, c.byref(native), None))
        try:
            self.check(self.security.SetFileSecurityW(str(path), 0x80000004, native))
            self.check(self.security.SetFileSecurityW(str(path), 0x10, native))
        finally:
            self.kernel.LocalFree(native)

    def descriptor_text(self, descriptor, information):
        output = w.LPWSTR()
        self.check(self.security.ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor, 1, information, c.byref(output), None))
        try:
            return output.value
        finally:
            self.kernel.LocalFree(output)

    def check_protection(self, path, user, app, role):
        if path.stat(follow_symlinks=False).st_file_attributes & 0x400:
            raise RuntimeError('Authority paths cannot be reparse points')
        descriptor = c.c_void_p()
        self.check(self.security.ConvertStringSecurityDescriptorToSecurityDescriptorW(self.protection(user, app, role), 1, c.byref(descriptor), None))
        try:
            expected = self.descriptor_text(descriptor, 0x14)
        finally:
            self.kernel.LocalFree(descriptor)
        if (self.security_descriptor(path, 0x14) != expected
                or self.security_descriptor(path, 1) != 'O:'+user):
            raise RuntimeError('Qualification authority or state has unsafe protection')

    def security_descriptor(self, path, information=0x17):
        size = w.DWORD()
        self.security.GetFileSecurityW(str(path), information, None, 0, c.byref(size))
        buffer = c.create_string_buffer(size.value)
        self.check(self.security.GetFileSecurityW(str(path), information, buffer, size, c.byref(size)))
        return self.descriptor_text(buffer, information)

    def lock_file(self, path):
        # No sharing for write/delete. Keep the actual files open through launch.
        handle = self.kernel.CreateFileW(str(path), 0x80000000, 1, None, 3, 0x80, None)
        if handle == c.c_void_p(-1).value:
            raise c.WinError(c.get_last_error())
        return handle

    def reject_named_streams(self, path):
        data = _StreamData()
        handle = self.kernel.FindFirstStreamW(str(path), 0, c.byref(data), 0)
        if handle == c.c_void_p(-1).value:
            if c.get_last_error() == 38:  # A directory normally has no data stream.
                return
            raise c.WinError(c.get_last_error())
        try:
            while True:
                if data.name != '::$DATA':
                    raise RuntimeError('Named NTFS streams are forbidden in qualified code')
                if not self.kernel.FindNextStreamW(handle, c.byref(data)):
                    if c.get_last_error() != 38:
                        raise c.WinError(c.get_last_error())
                    break
        finally:
            self.kernel.FindClose(handle)

    def spawn(self, command, environment, cwd, profile, app_sid, authority_identity, locks):
        import msvcrt
        sid = c.c_void_p()
        with _startup_phase('resolve_appcontainer'):
            hr = self.userenv.DeriveAppContainerSidFromAppContainerName(profile, c.byref(sid))
            if hr != 0:
                raise RuntimeError(f'Cannot resolve qualified AppContainer: {hr & 0xffffffff:#x}')
        handles, streams = [], []
        attributes = None
        info = _ProcessInfo()
        job = None
        success = False
        try:
            with _startup_phase('appcontainer_identity'):
                if self.sid_text(sid) != app_sid:
                    raise RuntimeError('AppContainer identity changed')
            pipes = []
            inherit = _SecurityAttributes(c.sizeof(_SecurityAttributes), None, True)
            for child_reads in (True, False, False):
                read, write = w.HANDLE(), w.HANDLE()
                with _startup_phase('CreatePipe'):
                    self.check(self.kernel.CreatePipe(c.byref(read), c.byref(write), c.byref(inherit), 0))
                handles.extend((read.value, write.value))
                child, parent = (read.value, write.value) if child_reads else (write.value, read.value)
                with _startup_phase('SetHandleInformation'):
                    self.check(self.kernel.SetHandleInformation(parent, 1, 0))
                pipes.append((child, parent))
            size = c.c_size_t()
            with _startup_phase('InitializeProcThreadAttributeList'):
                self.kernel.InitializeProcThreadAttributeList(None, 2, 0, c.byref(size))
                attributes = c.create_string_buffer(size.value)
                self.check(self.kernel.InitializeProcThreadAttributeList(attributes, 2, 0, c.byref(size)))
            caps = _Capabilities(sid, None, 0, 0)
            inherited = (w.HANDLE * 3)(*(pair[0] for pair in pipes))
            with _startup_phase('security_capabilities'):
                self.check(self.kernel.UpdateProcThreadAttribute(attributes, 0, 0x20009, c.byref(caps), c.sizeof(caps), None, None))
            with _startup_phase('inherited_handles'):
                self.check(self.kernel.UpdateProcThreadAttribute(attributes, 0, 0x20002, inherited, c.sizeof(inherited), None, None))
            startup = _StartupEx()
            startup.startup.cb = c.sizeof(startup)
            startup.startup.flags = 0x100
            startup.startup.stdin, startup.startup.stdout, startup.startup.stderr = (pair[0] for pair in pipes)
            startup.attributes = c.cast(attributes, c.c_void_p)
            with _startup_phase('CreateJobObjectW'):
                job = self.check(self.kernel.CreateJobObjectW(None, None))
            limits = _JobLimits()
            limits.basic.flags = 0x2000  # Kill only this fixture's descendants on close.
            with _startup_phase('SetInformationJobObject'):
                self.check(self.kernel.SetInformationJobObject(job, 9, c.byref(limits), c.sizeof(limits)))
            with _startup_phase('prepare_command'):
                cmdline = c.create_unicode_buffer(subprocess.list2cmdline(command))
                block = c.create_unicode_buffer('\0'.join(key+'='+value for key, value in sorted(environment.items()))+'\0\0')
            flags = 0x80000 | 0x8000000 | 0x400 | 0x4
            with _startup_phase('CreateProcessW'):
                self.check(self.kernel.CreateProcessW(command[0], cmdline, None, None, True, flags,
                                                     block, str(cwd), c.byref(startup), c.byref(info)))
            _startup_trace('CreateProcessW', 'created', candidate_pid=info.pid)
            with _startup_phase('AssignProcessToJobObject'):
                self.check(self.kernel.AssignProcessToJobObject(job, info.process))
            with _startup_phase('effective_token'):
                identity = self.identity(info.process)
                if (not identity['is_appcontainer'] or identity['appcontainer_sid'] != app_sid
                        or identity['integrity_sid'] != 'S-1-16-4096' or identity['capability_count'] != 0
                        or identity['user_sid'] != authority_identity['user_sid']):
                    raise RuntimeError('Candidate token does not match the qualified isolated identity')
            with _startup_phase('parent_streams'):
                for index, (child, parent) in enumerate(pipes):
                    self.kernel.CloseHandle(child)
                    handles.remove(child)
                    flags = os.O_BINARY | (os.O_WRONLY if index == 0 else os.O_RDONLY)
                    descriptor = msvcrt.open_osfhandle(parent, flags)
                    handles.remove(parent)
                    streams.append(os.fdopen(descriptor, 'wb' if index == 0 else 'rb', buffering=0))
            with _startup_phase('ResumeThread'):
                if self.kernel.ResumeThread(info.thread) != 1:
                    raise RuntimeError('Candidate was not safely suspended before resume')
            process = RunningCandidate(self, info.process, job, info.pid, identity, streams, locks)
            success = True
            return process
        finally:
            with _startup_phase('native_cleanup'):
                if info.thread:
                    self.kernel.CloseHandle(info.thread)
                if not success:
                    if info.process:
                        self.kernel.TerminateProcess(info.process, 1)
                        self.kernel.WaitForSingleObject(info.process, 5000)
                        self.kernel.CloseHandle(info.process)
                    if job:
                        self.kernel.CloseHandle(job)
                    for stream in streams:
                        stream.close()
                for handle in handles:
                    self.kernel.CloseHandle(handle)
                if attributes:
                    self.kernel.DeleteProcThreadAttributeList(attributes)
                self.security.FreeSid(sid)


class RunningCandidate:
    """Owned process and descendants, with exactly three inherited pipe handles."""
    def __init__(self, api, process, job, pid, identity, streams, locks):
        self._api, self._process, self._job = api, process, job
        self.pid, self.identity, self.returncode = pid, identity, None
        self.stdin, self.stdout, self.stderr = streams
        self._locks = locks

    def wait(self, timeout=None):
        milliseconds = 0xffffffff if timeout is None else max(0, int(timeout * 1000))
        result = self._api.kernel.WaitForSingleObject(self._process, milliseconds)
        if result == 258:
            raise subprocess.TimeoutExpired(str(self.pid), timeout)
        if result != 0:
            raise c.WinError(c.get_last_error())
        code = w.DWORD()
        self._api.check(self._api.kernel.GetExitCodeProcess(self._process, c.byref(code)))
        self.returncode = code.value
        if self._job:
            self._api.kernel.CloseHandle(self._job)
            self._job = None
        for handle in self._locks:
            self._api.kernel.CloseHandle(handle)
        self._locks.clear()
        return self.returncode

    def communicate(self, input=None, timeout=None):
        deadline = None if timeout is None else time.monotonic()+timeout
        def remaining():
            return None if deadline is None else max(0, deadline-time.monotonic())
        output = [None, None]
        errors = []
        def read(index, stream):
            try:
                output[index] = stream.read()
            except (OSError, ValueError) as error:
                errors.append(error)
        def write():
            try:
                if not self.stdin.closed and input is not None:
                    pending = memoryview(input)
                    while pending:
                        written = self.stdin.write(pending)
                        if not written:
                            raise BrokenPipeError('Candidate stdin closed')
                        pending = pending[written:]
            except BrokenPipeError:
                pass
            except (OSError, ValueError) as error:
                errors.append(error)
            finally:
                self.stdin.close()
        threads = [threading.Thread(target=read, args=(i, stream), daemon=True)
                   for i, stream in enumerate((self.stdout, self.stderr))]
        threads.append(threading.Thread(target=write, daemon=True))
        for thread in threads:
            thread.start()
        try:
            self.wait(remaining())
            for thread in threads:
                thread.join(remaining())
                if thread.is_alive():
                    raise subprocess.TimeoutExpired(str(self.pid), timeout)
        except subprocess.TimeoutExpired:
            self.kill()
            self.wait(5)
            for thread in threads:
                thread.join(1)
            raise subprocess.TimeoutExpired(str(self.pid), timeout)
        if errors:
            raise RuntimeError('Candidate pipe failed') from errors[0]
        return tuple(output)

    def kill(self):
        if self._job:
            self._api.check(self._api.kernel.TerminateJobObject(self._job, 1))

    def close(self):
        if self._process:
            if self.returncode is None:
                self.kill()
                self.wait(5)
            for stream in (self.stdin, self.stdout, self.stderr):
                stream.close()
            self._api.kernel.CloseHandle(self._process)
            self._process = None

    def __enter__(self):
        return self

    def __exit__(self, *ignored):
        self.close()


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()


class WindowsCandidate:
    """One fresh authority, one fixed command, one isolated application identity."""
    @classmethod
    def create(cls, root):
        self = cls()
        self._api = _Windows()
        self.authority_identity = self._api.identity()
        if self.authority_identity['is_appcontainer'] or self.authority_identity['integrity_sid'] not in ('S-1-16-8192', 'S-1-16-12288', 'S-1-16-16384'):
            raise RuntimeError('Authority must be outside the candidate at medium integrity or higher')
        root = Path(root)
        if not root.is_absolute():
            raise RuntimeError('Disposable root must be absolute')
        root.mkdir(exist_ok=False)
        self.root = root.resolve()
        self.code, self.state, self._authority = (self.root/name for name in ('code', 'state', 'authority'))
        self.authority_key = self._authority/'qualification.key'
        self._manifest = self._authority/'target.json'
        self._profile = 'codex.p03.'+uuid.uuid4().hex
        sid = c.c_void_p()
        hr = self._api.userenv.CreateAppContainerProfile(self._profile, self._profile,
                    'P03 isolated candidate; retain until approved cleanup', None, 0, c.byref(sid))
        if hr != 0:
            raise RuntimeError(f'Cannot create a fresh AppContainer profile: {hr & 0xffffffff:#x}')
        try:
            self.appcontainer_sid = self._api.sid_text(sid)
        finally:
            self._api.security.FreeSid(sid)
        profile_file = self.root/'profile.json'
        profile_file.write_text(json.dumps({'profile': self._profile, 'sid': self.appcontainer_sid,
            'root': str(self.root), 'authority_identity': self.authority_identity, 'disposable': True}, indent=2)+'\n', encoding='utf-8')
        self._protect(self.root, 'code')
        self._protect(profile_file, 'authority')
        for path, role in ((self.code, 'code'), (self.state, 'state'), (self._authority, 'authority')):
            path.mkdir()
            self._protect(path, role)
        self.authority_key.write_bytes(os.urandom(32))
        self._protect(self.authority_key, 'authority')
        self._authority_security = {str(path): self._api.security_descriptor(path)
                                    for path in (self.root, self._authority, self.authority_key, self.state, profile_file)}
        self.launches = 0
        return self

    @classmethod
    def open(cls, root):
        """Reopen a qualified target without creating a profile or changing ACLs."""
        self = cls()
        self._api = _Windows()
        self.authority_identity = self._api.identity()
        if self.authority_identity['is_appcontainer'] or self.authority_identity['integrity_sid'] not in ('S-1-16-8192', 'S-1-16-12288', 'S-1-16-16384'):
            raise RuntimeError('Authority must be outside the candidate at medium integrity or higher')
        self.root = Path(root)
        if not self.root.is_absolute() or self.root.resolve() != self.root:
            raise RuntimeError('Qualified root must be absolute and cannot move')
        self.code, self.state, self._authority = (self.root/name for name in ('code', 'state', 'authority'))
        self.authority_key = self._authority/'qualification.key'
        self._manifest = self._authority/'target.json'
        profile_file = self.root/'profile.json'
        user = self.authority_identity['user_sid']
        # Validate protection before reading any key or trusting profile metadata.
        for path in (self._authority, self.authority_key, self._manifest, profile_file):
            self._api.check_protection(path, user, None, 'authority')
        metadata = json.loads(profile_file.read_text(encoding='utf-8'))
        if metadata.get('disposable') is not True or metadata.get('root') != str(self.root) or metadata.get('authority_identity') != self.authority_identity:
            raise RuntimeError('Profile belongs to another qualification authority')
        self._profile = metadata['profile']
        self.appcontainer_sid = metadata['sid']
        self._api.check_protection(self.root, user, self.appcontainer_sid, 'code')
        self._api.check_protection(self.state, user, self.appcontainer_sid, 'state')
        self._authority_security = {str(path): self._api.security_descriptor(path)
                                   for path in (self.root, self._authority, self.authority_key, self.state, profile_file, self._manifest)}
        self.launches = 0
        self._load_payload()
        return self

    def _protect(self, path, role):
        self._api.protect(path, self.authority_identity['user_sid'], self.appcontainer_sid, role)

    def _check_authority(self):
        if self._api.identity() != self.authority_identity:
            raise RuntimeError('Authority identity changed')
        if self.root.resolve() != self.root:
            raise RuntimeError('Disposable root moved')
        for path, descriptor in self._authority_security.items():
            if self._api.security_descriptor(path) != descriptor:
                raise RuntimeError('Authority or state protection changed')

    def _paths(self):
        stack, result = [self.code], []
        while stack:
            path = stack.pop()
            metadata = path.stat(follow_symlinks=False)
            if metadata.st_file_attributes & 0x400:
                raise RuntimeError('Reparse points are forbidden in qualified code')
            self._api.reject_named_streams(path)
            if stat.S_ISDIR(metadata.st_mode):
                result.append((path, True))
                stack.extend(sorted(path.iterdir(), reverse=True))
            elif stat.S_ISREG(metadata.st_mode):
                if metadata.st_nlink != 1:
                    raise RuntimeError('Hardlinked files are forbidden before setting code protection')
                result.append((path, False))
            else:
                raise RuntimeError('Qualified code contains a nonregular file')
        return result

    def _snapshot(self, locks=None):
        result = {}
        for path, directory in self._paths():
            if not directory and locks is not None:
                locks.append(self._api.lock_file(path))
            value = {'directory': directory, 'security': self._api.security_descriptor(path)}
            if not directory:
                value['sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
            result[path.relative_to(self.code).as_posix()] = value
        return result

    def _validate_command(self, argv):
        if not isinstance(argv, list) or len(argv) != 4 or any(not isinstance(arg, str) or '\0' in arg for arg in argv):
            raise RuntimeError('A fixed isolated runtime and sealed script are required')
        executable, entry = Path(argv[0]), Path(argv[-1])
        families = {'python.exe': (['-I', '-B'], {'.py'}),
                    'node.exe': (['--preserve-symlinks', '--preserve-symlinks-main'], {'.js', '.mjs', '.cjs'})}
        family = families.get(executable.name.lower())
        if family is None or argv[1:3] != family[0] or entry.suffix.lower() not in family[1]:
            raise RuntimeError('Unsupported runtime command; no dynamic code or ambient module path')
        for path in (executable, entry):
            if any(':' in part for part in path.parts[1:]):
                raise RuntimeError('NTFS stream paths cannot be runtime commands')
            if not path.is_absolute() or not path.resolve().is_relative_to(self.code) or not path.is_file():
                raise RuntimeError('Executable and entry script must be inside qualified code')

    def qualify(self, argv, env=None):
        self._check_authority()
        if self._manifest.exists():
            raise RuntimeError('Target is already qualified; create another disposable root')
        self._validate_command(argv)
        for path, unused in self._paths():
            self._protect(path, 'code')
        allowed = {'SYSTEMROOT', 'WINDIR', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'ALLUSERSPROFILE', 'PROGRAMDATA'}
        environment = {key.upper(): value for key, value in os.environ.items() if key.upper() in allowed}
        # LOCALAPPDATA is needed by Windows to resolve the newly created profile.
        if not {'SYSTEMROOT', 'LOCALAPPDATA', 'USERPROFILE'} <= environment.keys():
            raise RuntimeError('Required Windows environment is missing')
        environment.update(TEMP=str(self.state), TMP=str(self.state),
                           PATH=str(self.code)+';'+str(Path(environment['SYSTEMROOT'])/'System32'))
        for key, value in (env or {}).items():
            if (not isinstance(key, str) or not isinstance(value, str) or not key or '=' in key
                    or '\0' in key+value or key.upper() in environment or key.upper().startswith(('PYTHON', 'NODE_'))):
                raise RuntimeError('Unsafe candidate environment override')
            environment[key] = value
        payload = {'schema': 'windows-candidate-v1', 'root': str(self.root), 'profile': self._profile,
                   'appcontainer_sid': self.appcontainer_sid, 'argv': argv, 'env': environment,
                   'code': self._snapshot()}
        signature = hmac.new(self.authority_key.read_bytes(), _canonical(payload), hashlib.sha256).hexdigest()
        self._manifest.write_text(json.dumps({'payload': payload, 'signature': signature}, indent=2)+'\n', encoding='utf-8')
        self._protect(self._manifest, 'authority')
        self._authority_security[str(self._manifest)] = self._api.security_descriptor(self._manifest)
        return signature

    def _load_payload(self):
        record = json.loads(self._manifest.read_text(encoding='utf-8'))
        payload = record['payload']
        key = self.authority_key.read_bytes()
        if len(key) != 32:
            raise RuntimeError('Qualification key must have 32 bytes')
        expected = hmac.new(key, _canonical(payload), hashlib.sha256).hexdigest()
        if not isinstance(record['signature'], str) or not hmac.compare_digest(record['signature'], expected):
            raise RuntimeError('Candidate qualification signature is invalid')
        if (payload['schema'] != 'windows-candidate-v1' or payload['root'] != str(self.root)
                or payload['profile'] != self._profile or payload['appcontainer_sid'] != self.appcontainer_sid):
            raise RuntimeError('Qualification belongs to another candidate')
        self._validate_command(payload['argv'])
        return payload

    def start(self):
        with _startup_phase('start'):
            with _startup_phase('authority_check'):
                self._check_authority()
            locks = []
            try:
                with _startup_phase('manifest_read'):
                    if not self._manifest.is_file():
                        raise RuntimeError('Candidate has no qualified target')
                    payload = self._load_payload()
                with _startup_phase('code_snapshot'):
                    if self._snapshot(locks) != payload['code']:
                        raise RuntimeError('Qualified candidate code or protection changed')
                with _startup_phase('spawn'):
                    process = self._api.spawn(payload['argv'], payload['env'], self.state, self._profile,
                                              self.appcontainer_sid, self.authority_identity, locks)
                self.launches += 1
                return process
            except (KeyError, TypeError, ValueError, OSError) as error:
                raise RuntimeError('Candidate qualification or isolated startup failed') from error
            finally:
                if 'process' not in locals():
                    with _startup_phase('release_code_locks'):
                        for handle in locks:
                            self._api.kernel.CloseHandle(handle)


def main():
    import argparse
    parser = argparse.ArgumentParser(description='Run one previously qualified Windows candidate')
    parser.add_argument('operation', choices=['run'])
    parser.add_argument('root', type=Path)
    arguments = parser.parse_args()
    try:
        candidate = WindowsCandidate.open(arguments.root)
        with candidate.start() as child:
            def relay(source, destination):
                try:
                    while data := os.read(source.fileno(), 65536):
                        destination.write(data)
                        destination.flush()
                except (BrokenPipeError, OSError, ValueError):
                    pass  # Peer closure is handled by the owned process lifecycle.
                finally:
                    if destination is child.stdin:
                        destination.close()
            routes = ((sys.stdin.buffer, child.stdin), (child.stdout, sys.stdout.buffer),
                      (child.stderr, sys.stderr.buffer))
            threads = [threading.Thread(target=relay, args=route, daemon=True) for route in routes]
            for thread in threads:
                thread.start()
            result = child.wait()
            for thread in threads[1:]:
                thread.join(5)
                if thread.is_alive():
                    raise RuntimeError('Candidate output did not close')
            return result
    except (RuntimeError, OSError, ValueError, KeyError, TypeError) as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
