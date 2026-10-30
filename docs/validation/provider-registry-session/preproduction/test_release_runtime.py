import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import release


class RuntimeIdentityTests(unittest.TestCase):
    def financial_state(self):
        control = self.root/'recovery'/'workspace-a'
        control.mkdir(parents=True)
        # This service unit tests the external controller's ordering. Authentic
        # SQLite/HMAC and target qualification belong to the paired reader tests.
        # No vault installation or global Python package is borrowed by service CI.
        (control/'provider-registry').mkdir()
        (control/'provider-registry.key').write_bytes(b'r'*32)
        reader = (lambda *args: object(), lambda registry: frozenset({'internal_finance_v1'}),
                  lambda *args, **kwargs: None)
        patched = patch.object(release, '_financial_reader', return_value=reader)
        patched.start()
        self.addCleanup(patched.stop)
        config = {'host': '127.0.0.1', 'provider': 'simulated', 'image': 'sha256:'+'a'*64,
                  'providerRegistryRequired': True,
                  'workspaces': [{'workspaceId': 'workspace-a', 'tenantId': 'tenant-a',
                                  'engine': {'restoreGuardDir': str(control)}}]}
        (self.root/'config.json').write_text(json.dumps(config))
        return None, config

    def test_financial_check_refuses_unqualified_target_before_any_command(self):
        self.financial_state()
        with patch.object(release.subprocess, 'run') as run:
            with self.assertRaisesRegex(RuntimeError, 'qualification unavailable'):
                release.check(self.directory)
        run.assert_not_called()

    def test_financial_activate_refuses_before_stop_install_or_start(self):
        self.financial_state()
        with patch.object(release.subprocess, 'run') as run, patch.object(release.installer, 'install') as install:
            with self.assertRaisesRegex(RuntimeError, 'qualification unavailable'):
                release.activate(self.root, self.directory, self.proof())
        run.assert_not_called()
        install.assert_not_called()

    def test_financial_freely_written_manifest_and_compatible_flag_cannot_grant_capability(self):
        import hashlib
        import hmac
        def canonical(value):
            return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)
        _, config = self.financial_state()
        manifest = release.load_release(self.directory)
        key = b'k'*32
        claims = {'schema': 'financial-target-v1', 'artifact_sha256': manifest['runtimeHash'],
                  'engine_image': config['image'], 'capabilities': ['internal_finance_v1']}
        (self.root/'secrets').mkdir()
        (self.root/'secrets'/'financial-release-authority.key').write_bytes(key)
        reports = self.root/'financial-targets'
        reports.mkdir()
        proof = {'claims': claims, 'signature': hmac.new(key, canonical(claims).encode(), hashlib.sha256).hexdigest()}
        (reports/(manifest['runtimeHash']+'.json')).write_text(json.dumps(proof))
        release.financial_preflight(self.root, self.directory, config)
        (self.directory/'dist'/'index.js').write_text('export const fixture = false;')
        manifest.update(compiledHash=release.fingerprint(self.directory/'dist'),
                        runtimeHash=release.runtime_fingerprint(self.directory), compatible=True)
        manifest['releaseId'] = 'local-' + manifest['runtimeHash']
        (self.directory/'manifest.json').write_text(json.dumps(manifest))
        with self.assertRaisesRegex(RuntimeError, 'qualification unavailable'):
            release.financial_preflight(self.root, self.directory, {**config, 'compatible': True})

    def test_financial_reader_refusal_blocks_all_target_commands(self):
        _, config = self.financial_state()
        manifest = release.load_release(self.directory)
        (self.root/'secrets').mkdir()
        (self.root/'secrets'/'financial-release-authority.key').write_bytes(b'k'*32)
        (self.root/'financial-targets').mkdir()
        (self.root/'financial-targets'/(manifest['runtimeHash']+'.json')).write_text('{}')
        registry, required, _ = release._financial_reader()
        def refuse(*args, **kwargs):
            raise RuntimeError('trusted reader refused target')
        with patch.object(release, '_financial_reader', return_value=(registry, required, refuse)), patch.object(release.subprocess, 'run') as run:
            with self.assertRaisesRegex(RuntimeError, 'trusted reader refused target'):
                release.check(self.directory)
        run.assert_not_called()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'source'
        (self.source / 'dist').mkdir(parents=True)
        (self.source / 'dist/index.js').write_text('export const fixture = true;')
        (self.source / 'package.json').write_text('{"type":"module"}')
        self.directory = release.stage(self.source, self.root, 'base')

    def proof(self):
        return release.report(self.directory, 'gates', {
            'status': 'PASS',
            'checks': dict.fromkeys(['node', 'browser', 'publication'], 'PASS'),
        })

    def test_copied_package_change_invalidates_pass_proof(self):
        proof = self.proof()
        (self.directory / 'package.json').write_text('{"type":"commonjs"}')
        with self.assertRaisesRegex(RuntimeError, 'identity mismatch'):
            release.require_gates(self.directory, proof)

    def test_source_package_change_blocks_check_before_commands(self):
        (self.source / 'package.json').write_text('{"type":"commonjs"}')
        with patch.object(release.subprocess, 'run') as run:
            with self.assertRaisesRegex(RuntimeError, 'differs from immutable release'):
                release.check(self.directory)
        run.assert_not_called()

    def test_source_package_change_during_check_does_not_publish_pass(self):
        def change_package(*args, **kwargs):
            (self.source / 'package.json').write_text('{"type":"commonjs"}')
            return type('Result', (), {'returncode': 0})()

        with patch.object(release, 'npm_command', return_value=['npm']), patch.object(
            release.subprocess, 'run', side_effect=change_package
        ):
            with self.assertRaisesRegex(RuntimeError, 'changed during validation'):
                release.check(self.directory)
        self.assertFalse((self.directory / 'reports').exists())

    def test_legacy_manifest_without_runtime_proof_is_rejected(self):
        manifest_path = self.directory / 'manifest.json'
        manifest = json.loads(manifest_path.read_text())
        manifest.pop('runtimeHash', None)
        manifest_path.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(RuntimeError, 'runtime identity'):
            release.load_release(self.directory)

    def test_same_dist_different_package_has_different_identity(self):
        first = release.load_release(self.directory)
        (self.source / 'package.json').write_text('{"type":"commonjs"}')
        other = release.stage(self.source, self.root, 'base')
        second = release.load_release(other)
        self.assertEqual(first['compiledHash'], second['compiledHash'])
        self.assertNotEqual(first['runtimeHash'], second['runtimeHash'])
        self.assertNotEqual(first['releaseId'], second['releaseId'])

    def test_gate_evidence_requires_runtime_hash(self):
        proof = self.proof()
        record = json.loads(proof.read_text())
        record.pop('runtimeHash', None)
        proof.write_text(json.dumps(record))
        with self.assertRaisesRegex(RuntimeError, 'another release'):
            release.require_gates(self.directory, proof)


if __name__ == '__main__':
    unittest.main()
