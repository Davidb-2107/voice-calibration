import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import release


class RuntimeIdentityTests(unittest.TestCase):
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
