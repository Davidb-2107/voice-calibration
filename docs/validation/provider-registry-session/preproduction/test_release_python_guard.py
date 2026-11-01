"""Real interpreter counterproofs, including rejection before business imports."""
import json
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
PY311 = os.environ.get('P03_PY311')
PY314 = os.environ.get('P03_PY314')


def record_runtime_case(name, command, result, **observations):
    directory = os.environ.get('P03_RUNTIME_RECORD_DIR')
    if directory:
        root = Path(directory)
        root.mkdir(parents=True,exist_ok=True)
        data = {'command':command,'exit_code':result.returncode,'stdout':result.stdout,
                'stderr':result.stderr,**observations}
        executable = Path(command[0])
        data['interpreter_sha256'] = hashlib.sha256(executable.read_bytes()).hexdigest()
        data['interpreter_version'] = subprocess.check_output(
            [str(executable), '-I', '-B', '--version'], text=True, timeout=15).strip()
        (root / (name+'.json')).write_text(json.dumps(data,indent=2)+'\n',encoding='utf-8')


class OperatorRuntimeTests(unittest.TestCase):
    def assert_runtime_version(self, interpreter, version):
        observed = subprocess.check_output(
            [interpreter, '-I', '-B', '--version'], text=True, timeout=15)
        expected = 'Python 3.' + version[1:] + '.'
        self.assertTrue(observed.startswith(expected), observed)

    def assert_library_refuses_runtime(self, interpreter, version):
        self.assert_runtime_version(interpreter, version)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ('release.py', 'operator_runtime.py'):
                shutil.copyfile(HERE/name, root/name)
            marker = root/'business-imported'
            poison = f'from pathlib import Path\nPath({str(marker)!r}).write_text("business")\nraise RuntimeError("BUSINESS IMPORTED")\n'
            for name in ('install_provider_registry.py', 'restore.py'):
                (root/name).write_text(poison)
            bootstrap = root/'probe.py'
            bootstrap.write_text(f'import sys\nsys.path.insert(0,{str(root)!r})\nimport release\n')
            command = [interpreter, '-B', str(bootstrap)]
            result = subprocess.run(command, capture_output=True, text=True, timeout=15)
            record_runtime_case(f'reject{version}-release-library', command, result,
                                business_imported=marker.exists())
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('requires Python 3.12', result.stderr)
            self.assertFalse(marker.exists(), result.stderr)

    @unittest.skipUnless(PY311, 'Explicit disposable Python 3.11 runtime required')
    def test_imported_release_refuses_python311_before_business_modules(self):
        self.assert_library_refuses_runtime(PY311, '311')

    @unittest.skipUnless(PY314, 'Explicit disposable Python 3.14 runtime required')
    def test_imported_release_refuses_python314_before_business_modules(self):
        self.assert_library_refuses_runtime(PY314, '314')

    def test_registry_reader_rejects_another_interpreter_before_reading_authority(self):
        peer = os.environ.get('P03_PEER_PY312')
        if not peer:
            self.skipTest('Explicit disposable second Python 3.12 runtime required')
        import provider_registry_status as status
        config = {'providerRegistryRequired': True, 'registryPython': peer,
                  'workspaces': [{'workspaceId': 'workspace-a', 'tenantId': 'tenant-a',
                                  'engine': {'restoreGuardDir': str(HERE/'unused-synthetic-authority')}}]}
        error = None
        with patch.object(status, 'ProviderRegistry') as registry:
            try:
                status.verify(config)
            except Exception as observed:
                error = observed
            evidence = os.environ.get('P03_RUNTIME_RECORD_DIR')
            if evidence:
                target = Path(evidence)
                target.mkdir(parents=True, exist_ok=True)
                data = {'caller_python': sys.executable, 'configured_peer': peer,
                        'exception_type': type(error).__name__, 'error': str(error),
                        'authority_read': registry.called, 'installed_changes': False}
                (target/'status-reject-different312.json').write_text(json.dumps(data, indent=2)+'\n')
            self.assertIsInstance(error, RuntimeError)
            self.assertIn('same operator interpreter', str(error))
            registry.assert_not_called()

    def test_activation_rejects_another_interpreter_before_stopping_service(self):
        peer = os.environ.get('P03_PEER_PY312')
        if not peer:
            self.skipTest('Explicit disposable second Python 3.12 runtime required')
        from test_release_prestart import InstalledPrestartTests
        import release
        fixture = InstalledPrestartTests('test_valid_legacy_authority_and_exact_workspace_are_checked')
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        fixture.config['registryPython'] = peer
        fixture.save_config()
        marker = fixture.root / 'stop-called'
        (fixture.root / 'control.py').write_text(f'from pathlib import Path\nPath({str(marker)!r}).write_text("stop")\n')
        error = None
        with patch.object(release,'require_gates',return_value=release.load_release(fixture.target)), \
             patch.object(release,'protected',side_effect=RuntimeError('AFTER STOP BOUNDARY')):
            try:
                release.activate(fixture.root,fixture.target,fixture.root / 'unused-evidence.json')
            except Exception as observed:
                error = observed
        evidence = os.environ.get('P03_RUNTIME_RECORD_DIR')
        if evidence:
            target = Path(evidence)
            target.mkdir(parents=True,exist_ok=True)
            data = {'operation':'release.activate','caller_python':sys.executable,'configured_peer':peer,
                    'exception_type':type(error).__name__,'error':str(error),
                    'stop_called':marker.exists(),'installed_changes':False}
            (target / 'activation-reject-different312.json').write_text(json.dumps(data,indent=2)+'\n',encoding='utf-8')
        self.assertFalse(marker.exists(),'A mismatched runtime must be rejected before stopping any service')
        self.assertIsInstance(error,RuntimeError)
        self.assertIn('same operator interpreter',str(error))

    def assert_entries_refuse_runtime(self, interpreter, version):
        self.assert_runtime_version(interpreter, version)
        for entry in ['boot_watchdog.py', 'control.py', 'watchdog.py', 'financial_preflight.py', 'release.py', 'provider_registry_status.py', 'windows_candidate.py']:
            with self.subTest(entry=entry), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                shutil.copyfile(HERE / entry, root / entry)
                if (HERE / 'operator_runtime.py').exists():
                    shutil.copyfile(HERE / 'operator_runtime.py',root / 'operator_runtime.py')
                marker = root / 'business-imported'
                poison = f"from pathlib import Path\nPath({str(marker)!r}).write_text('business')\nraise RuntimeError('BUSINESS IMPORTED')\n"
                for name in ['release.py','recover_owner.py','filelock.py','restore.py','install_provider_registry.py']:
                    if name != entry:
                        (root / name).write_text(poison)
                (root / 'application').mkdir()
                (root / 'application/__init__.py').write_text('')
                (root / 'application/provider_registry.py').write_text(poison)
                (root / 'voice_calibration/core').mkdir(parents=True)
                (root / 'voice_calibration/__init__.py').write_text(poison)
                (root / 'voice_calibration/core/__init__.py').write_text('')
                (root / 'voice_calibration/core/provider_registry.py').write_text(poison)
                bootstrap = root / 'run_entry.py'
                bootstrap.write_text('import runpy, sys\n'
                    f'sys.path.insert(0, {str(root)!r})\n'
                    f'sys.argv = [{str(root / entry)!r}, "start"]\n'
                    f'runpy.run_path({str(root / entry)!r}, run_name="__main__")\n')
                command = [interpreter,'-B',str(bootstrap)]
                result = subprocess.run(command,
                                        capture_output=True,text=True,timeout=15)
                record_runtime_case(f'reject{version}-'+entry,command,result,
                                    business_imported=marker.exists(),service_started=(root / 'service.log').exists())
                self.assertNotEqual(result.returncode,0)
                self.assertIn('requires Python 3.12',result.stderr)
                self.assertFalse(marker.exists(),result.stderr)
                self.assertFalse((root / 'service.log').exists())

    @unittest.skipUnless(PY311, 'Explicit disposable Python 3.11 runtime required')
    def test_python311_is_refused_before_operator_business_imports_or_start(self):
        self.assert_entries_refuse_runtime(PY311, '311')

    @unittest.skipUnless(PY314, 'Explicit disposable Python 3.14 runtime required')
    def test_python314_is_refused_before_operator_business_imports_or_start(self):
        self.assert_entries_refuse_runtime(PY314, '314')

    def test_python312_reader_accepts_existing_authority_and_reports_its_runtime(self):
        from test_release_prestart import InstalledPrestartTests
        fixture = InstalledPrestartTests('test_valid_legacy_authority_and_exact_workspace_are_checked')
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        result = subprocess.run([sys.executable,'-I','-B',str(fixture.root / 'financial_preflight.py')],
                                capture_output=True,text=True,timeout=15)
        self.assertEqual(result.returncode,0,result.stderr)
        verdict = json.loads(result.stdout)
        record_runtime_case('accept312-reader',[sys.executable,'-I','-B',str(fixture.root / 'financial_preflight.py')],result,
                            expected_interpreter=sys.executable,verdict=verdict)
        self.assertEqual(verdict['operatorVersion'][:2],[3,12])
        self.assertTrue(Path(verdict['operatorPython']).samefile(sys.executable))

    def assert_node_reader_refuses_runtime(self, interpreter, version):
        self.assert_runtime_version(interpreter, version)
        from test_release_prestart import InstalledPrestartTests
        fixture = InstalledPrestartTests('test_valid_legacy_authority_and_exact_workspace_are_checked')
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        fixture.config['registryPython'] = interpreter
        fixture.save_config()
        marker = fixture.root / 'business-imported'
        (fixture.root / 'release.py').write_text(
            f'from pathlib import Path\nPath({str(marker)!r}).write_text("business")\n'
            'raise RuntimeError("BUSINESS IMPORTED")\n')
        result = fixture.run_node("await createFinancialPreflight(config, root)('workspace-a');\n")
        record_runtime_case(f'node-reject{version}',[interpreter,'-I','-B',str(fixture.root / 'financial_preflight.py')],result,
                            node_command=result.args,business_imported=marker.exists())
        self.assertNotEqual(result.returncode,0)
        self.assertIn('requires Python 3.12',result.stderr)
        self.assertFalse(marker.exists(),result.stderr)

    @unittest.skipUnless(PY311, 'Explicit disposable Python 3.11 runtime required')
    def test_node_reader_refuses_python311_before_financial_import(self):
        self.assert_node_reader_refuses_runtime(PY311, '311')

    @unittest.skipUnless(PY314, 'Explicit disposable Python 3.14 runtime required')
    def test_node_reader_refuses_python314_before_financial_import(self):
        self.assert_node_reader_refuses_runtime(PY314, '314')

    def test_controller_refuses_a_different_configured_interpreter_before_recovery(self):
        peer = os.environ.get('P03_PEER_PY312')
        if not peer:
            self.skipTest('Explicit disposable second Python 3.12 runtime required')
        from test_release_prestart import InstalledPrestartTests
        fixture = InstalledPrestartTests('test_valid_legacy_authority_and_exact_workspace_are_checked')
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        fixture.config['registryPython'] = peer
        fixture.save_config()
        result = subprocess.run([sys.executable,'-B',str(fixture.root / 'control.py'),'start'],
                                capture_output=True,text=True,timeout=15)
        record_runtime_case('reject-different312',[sys.executable,'-B',str(fixture.root / 'control.py'),'start'],result,
                            configured_peer=peer,recovery_called=(fixture.root / 'recovery-called').exists(),
                            service_started=(fixture.root / 'service.log').exists())
        self.assertNotEqual(result.returncode,0)
        self.assertFalse((fixture.root / 'recovery-called').exists(),result.stderr)
        self.assertIn('same operator interpreter',result.stderr)


if __name__ == '__main__':
    unittest.main()
