"""Real Windows refusals and MCP composition; retain all disposable profiles."""
import json
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
    def copy_runtime(self, source, target):
        target.mkdir()
        for path in source.iterdir():
            if path.is_file():
                shutil.copy2(path, target / path.name)
        (target / 'python312._pth').write_text('python312.zip\n.\n', encoding='utf-8')

    def candidate(self, visible_key=False, sdk_root=None):
        import windows_candidate
        import windows_mcp_candidate as module
        root = Path(os.environ['P03_MCP_TEST_PARENT']) / uuid.uuid4().hex
        root.parent.mkdir(parents=True, exist_ok=True)
        real_sdk = windows_candidate.WindowsCandidate.open(Path(os.environ['P03_MCP_SDK_ROOT']))
        sdk = windows_candidate.WindowsCandidate.open(sdk_root) if sdk_root else real_sdk
        sdk_payload = sdk._load_payload()
        candidate = module.WindowsMcpCandidate.create(root)
        runtime = Path(sdk_payload['argv'][0]).parent
        self.copy_runtime(runtime, candidate.code / 'runtime')
        state = candidate.state / 'sdk-state'
        state.mkdir()
        corpus = candidate.state / 'corpus/voice_wpm.json'
        corpus.parent.mkdir()
        corpus.write_text('{}', encoding='utf-8')
        guard = candidate._authority / 'guard.json'
        guard.write_text('{}', encoding='utf-8')
        control = candidate._authority / 'dataset-control'
        control.mkdir()
        key = (candidate.root if visible_key else candidate._authority) / 'provider-registry.key'
        registry = candidate._authority / 'provider-registry'
        fixture = candidate._authority / 'fixture.py'
        fixture.write_text(
            'from voice_calibration.core.provider_registry import ProviderRegistry\n'
            f'ProviderRegistry.initialize({str(registry)!r}, {str(key)!r}, "mcp-fixture", "tenant-fixture")\n',
            encoding='utf-8')
        subprocess.run([real_sdk._load_payload()['argv'][0], '-I', '-B', str(fixture)], check=True,
                       capture_output=True, timeout=30)
        authority_env = {
            'VOICE_CALIBRATION_STATE_DIR': str(state),
            'VOICE_CALIBRATION_WORKSPACE_ID': 'mcp-fixture',
            'VOICE_CALIBRATION_TENANT_ID': 'tenant-fixture',
            'VOICE_WPM_PATH': str(corpus),
            'ELEVENLABS_API_KEY': 'synthetic-not-a-provider-credential',
            'VOICE_CALIBRATION_RESTORE_GUARD_PATH': str(guard),
            'VOICE_CALIBRATION_DATASET_CONTROL_DIR': str(control),
            'VOICE_CALIBRATION_PROVIDER_REGISTRY_DIR': str(registry),
            'VOICE_CALIBRATION_PROVIDER_REGISTRY_KEY': str(key),
        }
        entry = candidate.code / 'mcp_transport.py'
        shutil.copy2(Path(module.__file__).with_name('mcp_transport.py'), entry)
        candidate.qualify([str(candidate.code / 'runtime/python.exe'), '-I', '-B', str(entry)],
                          sdk_root=sdk.root, authority_env=authority_env)
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
            return replies.get(timeout=60) if 'id' in message else None
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
        candidate, command = self.candidate()
        evidence = self.exchange(command)
        session = json.loads((candidate._authority / 'mcp-session.json').read_text(encoding='utf-8'))
        self.record(candidate, {**evidence, 'session': session})
        self.assertTrue(session['worker_identity']['is_appcontainer'])
        self.assertFalse(session['sdk_identity']['is_appcontainer'])
        self.assertNotEqual(session['worker_pid'], session['sdk_pid'])
        self.assertEqual(session['ready']['pid'], session['worker_pid'])
        self.assertTrue(all(item['read_denied'] and item['write_denied'] and item['acl_denied']
                            for item in session['ready']['keys']))
        self.assertTrue(session['ready']['code']['write_denied'])
        self.assertTrue(session['ready']['code']['acl_denied'])
        self.assertEqual(session['ready']['sdk_code'], {'write_denied': True, 'acl_denied': True})

    def test_accessible_key_refuses_before_sdk_start(self):
        """A readable signing key must prevent every SDK business entry."""
        candidate, command = self.candidate(visible_key=True)
        run = subprocess.run(command, input=b'', capture_output=True, timeout=60)
        self.record(candidate, {'returncode': run.returncode, 'stderr': run.stderr.decode('utf-8', 'replace')})
        self.assertNotEqual(run.returncode, 0)
        self.assertFalse(run.stdout)
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

    def test_altered_sdk_module_refuses_before_business_import(self):
        """Skipping the external SDK inventory check must execute the marker."""
        from windows_candidate import WindowsCandidate
        real_sdk = WindowsCandidate.open(Path(os.environ['P03_MCP_SDK_ROOT']))
        sdk = WindowsCandidate.create(Path(os.environ['P03_MCP_TEST_PARENT']) / uuid.uuid4().hex)
        self.copy_runtime(Path(real_sdk._load_payload()['argv'][0]).parent, sdk.code / 'runtime')
        entry = sdk.code / 'entry.py'
        entry.write_text('import mcp_server\n', encoding='utf-8')
        module = sdk.code / 'runtime/mcp_server.py'
        module.write_text('# Qualified import-time business marker fixture.\n', encoding='utf-8')
        sdk.qualify([str(sdk.code / 'runtime/python.exe'), '-I', '-B', str(entry)])
        candidate, command = self.candidate(sdk_root=sdk.root)
        marker = sdk.state / 'business.started'
        module.write_text(f'from pathlib import Path\nPath({str(marker)!r}).write_text("started")\n', encoding='utf-8')
        run = subprocess.run(command, input=b'', capture_output=True, timeout=60)
        self.record(candidate, {'returncode': run.returncode, 'sdk_fixture': str(sdk.root),
                               'business_started': marker.exists(), 'stderr': run.stderr.decode('utf-8', 'replace')})
        self.assertNotEqual(run.returncode, 0)
        self.assertFalse(marker.exists())
        self.assertFalse((candidate._authority / 'mcp-session.json').exists())


if __name__ == '__main__':
    unittest.main()
