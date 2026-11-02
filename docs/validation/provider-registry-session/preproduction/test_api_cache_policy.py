"""A valid unchecked cache can run with -I -B; the qualified source policy must ignore it."""
import json
from pathlib import Path
import py_compile
import shutil
import subprocess
import sys
import tempfile
import unittest


class ApiCachePolicyTests(unittest.TestCase):
    def test_valid_unchecked_cache_cannot_replace_qualified_source(self):
        with tempfile.TemporaryDirectory(prefix='p03-source-policy-') as directory:
            root = Path(directory)
            controlled = root / 'controlled'
            controlled.mkdir()
            shutil.copyfile(Path(__file__).with_name('operator_runtime.py'), controlled / 'operator_runtime.py')
            (controlled / 'p03_fixture.py').write_text('value = "SOURCE"\n', encoding='utf-8')
            marker = root / 'cache-executed'
            payload = root / 'payload.py'
            payload.write_text('from pathlib import Path\nPath('+repr(str(marker))+').write_text("cache")\n'
                               'raise RuntimeError("UNQUALIFIED_CACHE_LOADED")\n', encoding='utf-8')
            cache = controlled / '__pycache__' / ('p03_fixture.'+sys.implementation.cache_tag+'.pyc')
            cache.parent.mkdir()
            py_compile.compile(str(payload), cfile=str(cache), doraise=True,
                               invalidation_mode=py_compile.PycInvalidationMode.UNCHECKED_HASH)
            script = root / 'probe.py'
            script.write_text('import json,sys\nsys.path.insert(0,'+repr(str(controlled))+')\n'
                              'if "--policy" in sys.argv:\n    import operator_runtime\n'
                              'import p03_fixture\nprint(json.dumps({"value":p03_fixture.value, '
                              '"isolated":sys.flags.isolated,"no_cache_write":sys.dont_write_bytecode}))\n', encoding='utf-8')
            unsafe = subprocess.run([sys.executable, '-I', '-B', str(script)], capture_output=True, text=True)
            self.assertNotEqual(unsafe.returncode, 0)
            self.assertIn('UNQUALIFIED_CACHE_LOADED', unsafe.stderr)
            self.assertTrue(marker.exists())
            marker.rename(root / 'positive-control')
            guarded = subprocess.run([sys.executable, '-I', '-B', str(script), '--policy'], capture_output=True, text=True)
            self.assertEqual(guarded.returncode, 0, guarded.stderr)
            self.assertEqual(json.loads(guarded.stdout), {'value': 'SOURCE', 'isolated': 1, 'no_cache_write': True})
            self.assertFalse(marker.exists())


if __name__ == '__main__':
    unittest.main()
