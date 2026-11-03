"""Real Windows refusals and MCP composition; retain all disposable profiles."""
import json
import ast
import os
from pathlib import Path
import shutil
import subprocess
import sys
import queue
import threading
import unittest
import uuid


@unittest.skipUnless(sys.platform == 'win32', 'requires Windows AppContainer')
class WindowsMcpCandidateTests(unittest.TestCase):
    def runtime_source(self):
        source = Path(os.environ['P03_MCP_RUNTIME_SOURCE']).resolve()
        self.assertTrue((source / 'python.exe').is_file())
        self.assertFalse(source.is_relative_to(Path(os.environ['P03_MCP_SDK_ROOT']).resolve()),
                         'Use a separately verified disposable runtime, never execute historical r3')
        return source

    def tool_runtime(self, target):
        # Stdlib-only helper fixture, distinct from the qualified full MCP runtime.
        target.mkdir(parents=True)
        for source in self.runtime_source().iterdir():
            if source.is_file():
                shutil.copy2(source, target / source.name)
        (target / 'python312._pth').write_text('python312.zip\n.\n', encoding='utf-8')
        return str(target / 'python.exe')

    def test_pipe_writer_keeps_full_frame_on_short_writes(self):
        from windows_mcp_candidate import _write_all
        class Pipe:
            data = bytearray()
            def write(self, data):
                self.data.extend(data[:3])
                return min(3, len(data))
            def flush(self):
                pass
        pipe = Pipe()
        _write_all(pipe, b'complete authority frame\n')
        self.assertEqual(pipe.data, b'complete authority frame\n')

    def test_sdk_source_ignores_matching_cached_bytecode(self):
        from importlib._bootstrap_external import _code_to_timestamp_pyc
        from importlib.util import cache_from_source
        import windows_mcp_candidate as transport
        fixture = Path(os.environ['P03_MCP_TEST_PARENT']) / ('source-only-'+uuid.uuid4().hex)
        package = fixture / 'runtime/Lib/site-packages/voice_calibration'
        package.mkdir(parents=True)
        source = package / '__init__.py'
        source.write_text('VALUE = "source"\n', encoding='utf-8')
        cache = Path(cache_from_source(str(source)))
        cache.parent.mkdir()
        cache.write_bytes(_code_to_timestamp_pyc(compile('VALUE = "cached"', str(source), 'exec'),
                          int(source.stat().st_mtime), source.stat().st_size))
        bootstrap = fixture / 'mcp_transport.py'
        shutil.copy2(Path(transport.__file__).with_name('mcp_transport.py'), bootstrap)
        probe = fixture / 'probe.py'
        probe.write_text(f'import sys, runpy\nsys.path.insert(0, {str(package.parent)!r})\n'
                         f'runpy.run_path({str(bootstrap)!r})["sdk_source_only"]()\n'
                         'import voice_calibration\nprint(voice_calibration.VALUE)\n', encoding='utf-8')
        python = self.tool_runtime(fixture / 'interpreter')
        run = subprocess.run([python, '-I', '-B', str(probe)],
                             capture_output=True, timeout=15)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(run.stdout.strip(), b'source')

    def copy_runtime(self, source, target):
        # Reuse sealed vendor PYC dependencies; only our SDK overlay is source-only.
        shutil.copytree(source, target, ignore=shutil.ignore_patterns('voice_calibration'))
        package = Path(os.environ['P03_MCP_PATCHED_PACKAGE'])
        self.assertFalse(list(package.rglob('*.pyc')), 'SDK source export must exclude caches')
        shutil.copytree(package, target / 'Lib/site-packages/voice_calibration', dirs_exist_ok=True)

    def business_marker(self, candidate):
        source = candidate.code / 'runtime/Lib/site-packages/voice_calibration/mcp_server/server.py'
        marker = candidate.state / 'business.started'
        text = source.read_text(encoding='utf-8')
        tree = ast.parse(text)
        at = max((node.end_lineno for node in tree.body if isinstance(node, ast.ImportFrom)
                  and node.module == '__future__'), default=0)
        lines = text.splitlines(keepends=True)
        lines.insert(at, 'import os as _fixture_os\n'
                     f'with open({str(marker)!r}, "a", encoding="utf-8") as _fixture_marker:\n'
                     '    _fixture_marker.write(str(_fixture_os.getpid()) + "\\n")\n')
        source.write_text(''.join(lines), encoding='utf-8')
        return marker

    def candidate(self, visible_key=False, sdk_root=None, altered_runtime=False, instrument=True, guard_name='guard.json'):
        import windows_candidate
        import windows_mcp_candidate as module
        root = Path(os.environ['P03_MCP_TEST_PARENT']) / uuid.uuid4().hex
        root.parent.mkdir(parents=True, exist_ok=True)
        real_sdk = windows_candidate.WindowsCandidate.open(Path(os.environ['P03_MCP_SDK_ROOT']))
        sdk = windows_candidate.WindowsCandidate.open(sdk_root) if sdk_root else real_sdk
        candidate = module.WindowsMcpCandidate.create(root)
        runtime = self.runtime_source()
        self.copy_runtime(runtime, candidate.code / 'runtime')
        state = candidate.state / 'sdk-state'
        state.mkdir()
        corpus = candidate.state / 'corpus/voice_wpm.json'
        corpus.parent.mkdir()
        corpus.write_text('{}', encoding='utf-8')
        guard = candidate._authority / guard_name
        guard.write_text(json.dumps({'version': 1, 'workspace_id': 'mcp-fixture', 'state': 'ready'}), encoding='utf-8')
        control = candidate._authority / 'dataset-control'
        control.mkdir()
        key = (candidate.root if visible_key else candidate._authority) / 'provider-registry.key'
        registry = candidate._authority / 'provider-registry'
        fixture = candidate._authority / 'fixture.py'
        fixture.write_text(
            'from voice_calibration.core.provider_registry import ProviderRegistry\n'
            f'ProviderRegistry.initialize({str(registry)!r}, {str(key)!r}, "mcp-fixture", "tenant-fixture-é")\n',
            encoding='utf-8')
        subprocess.run([str(candidate.code / 'runtime/python.exe'), '-I', '-B', str(fixture)], check=True,
                       capture_output=True, timeout=30)
        authority_env = {
            'VOICE_CALIBRATION_STATE_DIR': str(state),
            'VOICE_CALIBRATION_WORKSPACE_ID': 'mcp-fixture',
            'VOICE_CALIBRATION_TENANT_ID': 'tenant-fixture-é',
            'VOICE_WPM_PATH': str(corpus),
            'ELEVENLABS_API_KEY': 'synthetic-not-a-provider-credential',
            'VOICE_CALIBRATION_RESTORE_GUARD_PATH': str(guard),
            'VOICE_CALIBRATION_DATASET_CONTROL_DIR': str(control),
            'VOICE_CALIBRATION_PROVIDER_REGISTRY_DIR': str(registry),
            'VOICE_CALIBRATION_PROVIDER_REGISTRY_KEY': str(key),
        }
        entry = candidate.code / 'mcp_transport.py'
        shutil.copy2(Path(module.__file__).with_name('mcp_transport.py'), entry)
        fixture_source = candidate._authority / 'sdk-source-fixture'
        shutil.copytree(Path(os.environ['P03_MCP_PATCHED_PACKAGE']), fixture_source)
        if instrument:
            self.business_marker(candidate)
            shutil.copy2(candidate.code / 'runtime/Lib/site-packages/voice_calibration/mcp_server/server.py',
                         fixture_source / 'mcp_server/server.py')
        if altered_runtime:
            runtime_path = candidate.code / 'runtime/python312._pth'
            runtime_path.write_bytes(runtime_path.read_bytes()+b'\n# altered runtime provenance\n')
        candidate.qualify([str(candidate.code / 'runtime/python.exe'), '-I', '-B', str(entry)],
                          sdk_root=sdk.root, sdk_source=fixture_source,
                          authority_env=authority_env)
        command = [sys.executable, '-I', '-B', module.__file__, 'run', str(root)]
        return candidate, command

    def record(self, candidate, evidence):
        target = Path(os.environ['P03_MCP_TEST_PARENT']) / ('result-'+candidate.root.name+'.json')
        target.write_text(json.dumps({'test': self._testMethodName, 'root': str(candidate.root), **evidence}, indent=2)+'\n', encoding='utf-8')

    def exchange(self, command):
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        replies, diagnostics = queue.Queue(), []
        def read():
            for line in process.stdout:
                replies.put(json.loads(line))
        def errors():
            diagnostics.append(process.stderr.read())
        readers = [threading.Thread(target=read, daemon=True), threading.Thread(target=errors, daemon=True)]
        for reader in readers:
            reader.start()
        def request(message):
            process.stdin.write((json.dumps(message)+'\n').encode())
            process.stdin.flush()
            if 'id' not in message:
                return None
            try:
                return replies.get(timeout=60)
            except queue.Empty:
                raise AssertionError(f'MCP response absent, exit={process.poll()}, '
                                     f'stderr={b"".join(diagnostics).decode("utf-8", "replace")}') from None
        evidence = {}
        try:
            evidence['initialize'] = request({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize',
                'params': {'protocolVersion': '2024-11-05', 'capabilities': {}, 'clientInfo': {'name': 'qualification', 'version': '1'}}})
            self.assertIn('result', evidence['initialize'])
            request({'jsonrpc': '2.0', 'method': 'notifications/initialized'})
            evidence['tools'] = request({'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list', 'params': {}})
            self.assertIn('get_server_info', {t['name'] for t in evidence['tools']['result']['tools']})
            evidence['info'] = request({'jsonrpc': '2.0', 'id': 3, 'method': 'tools/call', 'params': {'name': 'get_server_info', 'arguments': {}}})
            self.assertFalse(evidence['info']['result'].get('isError', False), evidence['info'])
            for identifier, name, arguments in [(4, '_mac', {'document': 'forged'}), (5, 'get_live_profiles', {'workspace_id': 'foreign'})]:
                response = request({'jsonrpc': '2.0', 'id': identifier, 'method': 'tools/call', 'params': {'name': name, 'arguments': arguments}})
                self.assertTrue(response.get('error') or response['result'].get('isError'), response)
                evidence[name] = response
            process.stdin.close()
            self.assertEqual(process.wait(15), 0)
            for reader in readers:
                reader.join(5)
            evidence['stderr'] = b''.join(diagnostics).decode('utf-8', 'replace')
            return evidence
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(10)
            for stream in (process.stdin, process.stdout, process.stderr):
                stream.close()

    def test_mcp_keeps_authority_key_outside_the_working_transport(self):
        """Sharing a signer or exposing generic signatures must fail this."""
        candidate, command = self.candidate(instrument=False)
        evidence = self.exchange(command)
        session = json.loads((candidate._authority / 'mcp-session.json').read_text(encoding='utf-8'))
        self.record(candidate, {**evidence, 'session': session,
            'sdk_sources': candidate._load_payload()['mcp_authority']['sdk_sources'], 'sdk_instrumented': False})
        self.assertTrue(session['worker_identity']['is_appcontainer'])
        self.assertTrue(session['sdk_identity']['is_appcontainer'])
        self.assertEqual(session['worker_pid'], session['sdk_pid'])
        self.assertFalse(session['authority_identity']['is_appcontainer'])
        self.assertEqual(session['authority_startup']['tenant_id'], 'tenant-fixture-é')
        self.assertNotEqual(session['worker_pid'], session['authority_pid'])
        info = evidence['info']['result']
        structured = info.get('structuredContent')
        if structured is None:
            structured = json.loads(info['content'][0]['text'])
        self.assertEqual(structured['process_id'], session['worker_pid'])
        self.assertFalse((candidate.state / 'business.started').exists())
        self.assertEqual(session['ready']['pid'], session['worker_pid'])
        self.assertTrue(all(item['read_denied'] and item['write_denied'] and item['acl_denied']
                            for item in session['ready']['keys']))
        self.assertTrue(session['ready']['code']['write_denied'])
        self.assertTrue(session['ready']['code']['acl_denied'])
        self.assertEqual(session['ready']['sdk_code'], {'write_denied': True, 'acl_denied': True})
        self.assertEqual(session['ready']['runtime'], {'write_denied': True, 'acl_denied': True})

    def test_accessible_key_refuses_before_sdk_start(self):
        """A readable signing key must prevent every SDK business entry."""
        candidate, command = self.candidate(visible_key=True)
        run = subprocess.run(command, input=b'', capture_output=True, timeout=60)
        self.record(candidate, {'returncode': run.returncode, 'stderr': run.stderr.decode('utf-8', 'replace')})
        self.assertNotEqual(run.returncode, 0)
        self.assertFalse(run.stdout)
        self.assertFalse((candidate._authority / 'mcp-session.json').exists())
        self.assertFalse((candidate.state / 'business.started').exists())

    def test_copied_runtime_requires_original_qualified_bytes(self):
        with self.assertRaisesRegex(RuntimeError, 'Copied runtime or vendor dependency'):
            self.candidate(altered_runtime=True)

    def test_authority_startup_failure_refuses_before_business_import(self):
        candidate, command = self.candidate()
        (candidate._authority / 'guard.json').write_text('invalid-json', encoding='utf-8')
        run = subprocess.run(command, input=b'', capture_output=True, timeout=60)
        self.record(candidate, {'returncode': run.returncode, 'stderr': run.stderr.decode('utf-8', 'replace')})
        self.assertNotEqual(run.returncode, 0)
        self.assertFalse((candidate.state / 'business.started').exists())
        self.assertFalse((candidate._authority / 'mcp-session.json').exists())

    def test_checkpoint_only_authority_refuses_before_business_import(self):
        candidate, command = self.candidate(guard_name='deployment.json')
        checkpoint = candidate._authority / 'dataset-control/deployment.corpus-checkpoint.json'
        checkpoint.write_text(json.dumps({'schema': 'dataset-corpus-checkpoint-v1', 'state': 'ready'}), encoding='utf-8')
        run = subprocess.run(command, input=b'', capture_output=True, timeout=60)
        self.record(candidate, {'returncode': run.returncode, 'stderr': run.stderr.decode('utf-8', 'replace')})
        self.assertNotEqual(run.returncode, 0)
        self.assertFalse((candidate.state / 'business.started').exists())
        self.assertFalse((candidate._authority / 'mcp-session.json').exists())

    def test_altered_mcp_refuses_before_sdk_start(self):
        """Removing the pre-import fingerprint check must fail this."""
        candidate, command = self.candidate()
        entry = candidate.code / 'mcp_transport.py'
        entry.write_bytes(entry.read_bytes()+b'\n# altered\n')
        run = subprocess.run(command, input=b'', capture_output=True, timeout=60)
        self.record(candidate, {'returncode': run.returncode, 'stderr': run.stderr.decode('utf-8', 'replace')})
        self.assertNotEqual(run.returncode, 0)
        self.assertFalse(run.stdout)
        self.assertFalse((candidate._authority / 'mcp-session.json').exists())
        self.assertFalse((candidate.state / 'business.started').exists())

    def test_restart_rechecks_binding_before_business(self):
        """A changed SDK binding must not replace the reviewed SDK at restart."""
        candidate, command = self.candidate()
        first = self.exchange(command)
        first_session = json.loads((candidate._authority / 'mcp-session.json').read_bytes())
        second = self.exchange(command)
        second_session = json.loads((candidate._authority / 'mcp-session.json').read_bytes())
        self.assertNotEqual(first_session['worker_pid'], second_session['worker_pid'])
        self.assertEqual(first_session['ready']['version'], [3, 12, 10])
        self.assertEqual(second_session['ready']['version'], [3, 12, 10])
        self.assertEqual(first_session['sdk_argv'], second_session['sdk_argv'])
        self.assertEqual(first_session['ready']['python'], second_session['ready']['python'])
        import hashlib
        import hmac
        from windows_candidate import _canonical
        record = json.loads(candidate._manifest.read_bytes())
        record['payload']['mcp_authority']['target_sha256'] = '0'*64
        record['signature'] = hmac.new(candidate.authority_key.read_bytes(), _canonical(record['payload']), hashlib.sha256).hexdigest()
        candidate._manifest.write_text(json.dumps(record), encoding='utf-8')
        run = subprocess.run(command, input=b'', capture_output=True, timeout=60)
        self.record(candidate, {'first': first, 'second': second, 'first_session': first_session,
                               'second_session': second_session, 'refused_restart': run.returncode,
                               'stderr': run.stderr.decode('utf-8', 'replace')})
        self.assertNotEqual(run.returncode, 0)
        self.assertEqual(json.loads((candidate._authority / 'mcp-session.json').read_bytes()), second_session)
        self.assertEqual((candidate.state / 'business.started').read_text().splitlines(),
                         [str(first_session['worker_pid']), str(second_session['worker_pid'])])

    def test_altered_sdk_module_refuses_before_business_import(self):
        """Skipping the external SDK inventory check must execute the marker."""
        candidate, command = self.candidate()
        module = candidate.code / 'runtime/Lib/site-packages/voice_calibration/core/authority_client.py'
        module.write_bytes(module.read_bytes()+b'\n# altered\n')
        marker = candidate.state / 'business.started'
        run = subprocess.run(command, input=b'', capture_output=True, timeout=60)
        self.record(candidate, {'returncode': run.returncode,
                               'business_started': marker.exists(), 'stderr': run.stderr.decode('utf-8', 'replace')})
        self.assertNotEqual(run.returncode, 0)
        self.assertFalse(marker.exists())
        self.assertFalse((candidate._authority / 'mcp-session.json').exists())

    def test_forged_authority_response_on_external_mcp_channel_is_rejected(self):
        candidate, command = self.candidate()
        run = subprocess.run(command, input=b'@p03-authority-v1:{"id":1,"ok":true,"value":{},"error":null}\n',
                             capture_output=True, timeout=60)
        self.record(candidate, {'returncode': run.returncode, 'stderr': run.stderr.decode('utf-8', 'replace')})
        self.assertNotEqual(run.returncode, 0)

    def test_suspended_authority_failures_never_import_or_leave_an_orphan(self):
        import ctypes as c
        from ctypes import wintypes as w
        from windows_candidate import _Windows, _ProcessInfo
        from windows_mcp_candidate import _spawn_authority
        original = _Windows()
        fixture = Path(os.environ['P03_MCP_TEST_PARENT']) / ('lifecycle-'+uuid.uuid4().hex)
        fixture.mkdir(parents=True)
        python = self.tool_runtime(fixture / 'interpreter')
        entry = fixture / 'entry.py'
        positive = fixture / 'positive.started'
        entry.write_text('import pathlib, sys\npathlib.Path(sys.argv[1]).write_text("imported")\n', encoding='utf-8')
        subprocess.run([python, '-I', '-B', str(entry), str(positive)], check=True, timeout=15)
        self.assertTrue(positive.is_file())
        for failure in ('assignment', 'identity'):
            with self.subTest(failure=failure):
                events, child = [], {}
                marker = fixture / (failure+'.started')
                class Kernel:
                    def __getattr__(self, name):
                        return getattr(original.kernel, name)
                    def CreateProcessW(self, *args):
                        self_test.assertTrue(args[5] & 0x4)
                        result = original.kernel.CreateProcessW(*args)
                        info = c.cast(args[-1], c.POINTER(_ProcessInfo)).contents
                        child['pid'] = info.pid
                        events.append('suspended')
                        return result
                    def AssignProcessToJobObject(self, *args):
                        events.append('assign')
                        if failure == 'assignment':
                            raise RuntimeError('injected assignment failure')
                        return original.kernel.AssignProcessToJobObject(*args)
                    def ResumeThread(self, *args):
                        events.append('resume')
                        return original.kernel.ResumeThread(*args)
                class Api:
                    kernel = Kernel()
                    check = staticmethod(original.check)
                    def identity(self, process):
                        events.append('identity')
                        result = original.identity(process)
                        result['is_appcontainer'] = True
                        return result
                self_test = self
                job = original.check(original.kernel.CreateJobObjectW(None, None))
                try:
                    with self.assertRaises(RuntimeError):
                        _spawn_authority(Api(), [python, '-I', '-B', str(entry), str(marker)],
                                         dict(os.environ), fixture, job, original.identity())
                finally:
                    original.kernel.CloseHandle(job)
                self.assertFalse(marker.exists())
                self.assertNotIn('resume', events)
                # The suspended process was terminated and waited even if assignment failed.
                original.kernel.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
                original.kernel.OpenProcess.restype = w.HANDLE
                handle = original.kernel.OpenProcess(0x1000 | 0x100000, False, child['pid'])
                if handle:
                    try:
                        self.assertEqual(original.kernel.WaitForSingleObject(handle, 0), 0)
                        code = w.DWORD()
                        original.check(original.kernel.GetExitCodeProcess(handle, c.byref(code)))
                        self.assertNotEqual(code.value, 259)
                    finally:
                        original.kernel.CloseHandle(handle)


if __name__ == '__main__':
    unittest.main()
