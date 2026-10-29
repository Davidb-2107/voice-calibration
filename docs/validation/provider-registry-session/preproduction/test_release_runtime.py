import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import release


class RuntimeIdentityTests(unittest.TestCase):
    def financial_state(self):
        from voice_calibration.core.financial_contracts import FinanceScope, OperationSpec, SlotSpec, TrustedFinanceContext
        from voice_calibration.core.financial_ledger import FinancialLedger
        from voice_calibration.core.provider_registry import ProviderRegistry, digest
        control = self.root/'recovery'/'workspace-a'
        control.mkdir(parents=True)
        registry = ProviderRegistry.initialize(control/'provider-registry', control/'provider-registry.key', 'workspace-a', 'tenant-a')
        scope = FinanceScope(tenant_id='tenant-a', workspace_id='workspace-a', provider='elevenlabs', account_ref='fixture')
        context = TrustedFinanceContext(scope, 'operator', lambda: True, enabled=True, environment='synthetic')
        spec = OperationSpec(scope=scope, principal='operator', operation_kind='production', idempotency_key='fixture',
                             request_digest=digest('request'), configuration_identity='config', budget_id='fixture',
                             spec_sha256=digest('spec'), quote={}, slots=(SlotSpec(slot='audio', text_sha256=digest('text'), text_length=4),))
        FinancialLedger(registry).admit(spec, authority=context)
        config = {'host': '127.0.0.1', 'provider': 'simulated', 'image': 'sha256:'+'a'*64,
                  'providerRegistryRequired': True,
                  'workspaces': [{'workspaceId': 'workspace-a', 'tenantId': 'tenant-a',
                                  'engine': {'restoreGuardDir': str(control)}}]}
        (self.root/'config.json').write_text(json.dumps(config))
        return registry, config

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
        from voice_calibration.core.provider_registry import canonical
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
