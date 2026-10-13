from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import release


class ActiveReleaseStatusTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        source = self.root / 'source'
        (source / 'dist').mkdir(parents=True)
        (source / 'dist/index.js').write_text('export const fixture = true;')
        (source / 'package.json').write_text('{"type":"module"}')
        directory = release.stage(source, self.root, 'base')
        self.manifest = release.load_release(directory)
        proof = release.report(directory, 'gates', {
            'status': 'PASS',
            'checks': dict.fromkeys(['node', 'browser', 'publication'], 'PASS'),
        })
        self.config = {'releaseDir': str(directory), 'validationReport': str(proof),
                       'module': self.manifest['module'], 'commit': self.manifest['releaseId']}

    def cli(self):
        (self.root / 'config.json').write_text(json.dumps(self.config))
        with patch.object(release.sys, 'argv', ['release.py', 'status', '--root', str(self.root)]):
            release.main()

    def rejected(self, message):
        output = io.StringIO()
        with redirect_stdout(output), self.assertRaisesRegex(RuntimeError, message):
            self.cli()
        self.assertEqual(output.getvalue(), '')

    def test_matching_active_configuration_passes(self):
        output = io.StringIO()
        with redirect_stdout(output):
            self.cli()
        result = json.loads(output.getvalue())
        self.assertEqual(result['releaseId'], self.config['commit'])
        self.assertEqual(result['module'], self.config['module'])

    def test_other_active_module_cannot_pass_with_old_proof(self):
        self.config['module'] = str(self.root / 'OTHER-UNTESTED/index.js')
        self.rejected('differs from validated release')

    def test_other_active_commit_cannot_pass_with_old_proof(self):
        self.config['commit'] = 'OTHER-COMMIT'
        self.rejected('differs from validated release')

    def test_missing_configuration_fields_fail_closed(self):
        original = self.config.copy()
        for key in original:
            with self.subTest(key=key):
                self.config = original.copy()
                del self.config[key]
                self.rejected('configuration missing')

    def test_empty_or_non_string_binding_fails_closed(self):
        original = self.config.copy()
        for key in original:
            for value in ['', '  ', None, 42]:
                with self.subTest(key=key, value=value):
                    self.config = {**original, key: value}
                    self.rejected('configuration missing')

    def test_equivalent_canonical_module_path_passes(self):
        module = Path(self.config['module'])
        self.config['module'] = str(module.parent / 'unused/../index.js')
        output = io.StringIO()
        with redirect_stdout(output):
            self.cli()
        self.assertEqual(json.loads(output.getvalue())['module'], self.manifest['module'])

    def test_matching_configuration_still_requires_pass_proof(self):
        proof = Path(self.config['validationReport'])
        record = json.loads(proof.read_text())
        record['status'] = 'FAIL'
        proof.write_text(json.dumps(record))
        self.rejected('All release gates must pass')


if __name__ == '__main__':
    unittest.main()
