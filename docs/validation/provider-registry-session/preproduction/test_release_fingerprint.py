"""Release identity must preserve file boundaries and names."""
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

import release


class ReleaseFingerprintTests(unittest.TestCase):
    def test_absorbing_an_imported_file_invalidates_existing_gates(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'source'
            (source / 'dist').mkdir(parents=True)
            (source / 'dist/index.js').write_text('import "./z.js";\n// ')
            (source / 'dist/z.js').write_text('export const z=1;')
            (source / 'package.json').write_text('{"type":"module"}')
            directory = release.stage(source, root, 'fixture')
            proof = release.report(directory, 'gates', {
                'status': 'PASS',
                'checks': dict.fromkeys(['node', 'browser', 'publication'], 'PASS'),
            })
            before = release.fingerprint(directory / 'dist')
            entry = directory / 'dist/index.js'
            extra = directory / 'dist/z.js'
            entry.write_bytes(entry.read_bytes() + b'z.js' + extra.read_bytes())
            extra.unlink()

            self.assertNotEqual(before, release.fingerprint(directory / 'dist'))
            with self.assertRaisesRegex(RuntimeError, 'content or module identity mismatch'):
                release.require_gates(directory, proof)

    def test_name_content_boundary_and_creation_order(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            first, second = root / 'first', root / 'second'
            first.mkdir()
            second.mkdir()
            (first / 'a').write_bytes(b'bc')
            (second / 'ab').write_bytes(b'c')
            self.assertNotEqual(release.fingerprint(first), release.fingerprint(second))
            (second / 'ab').unlink()
            (second / 'z').write_bytes(b'last')
            (second / 'a').write_bytes(b'bc')
            (first / 'z').write_bytes(b'last')
            self.assertEqual(release.fingerprint(first), release.fingerprint(second))


if __name__ == '__main__':
    unittest.main()
