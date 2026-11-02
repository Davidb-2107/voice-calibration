"""An unqualified Node must be refused before supervision can spawn it."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

import boot_watchdog


class ApiNodeBindingTests(unittest.TestCase):
    @unittest.skipUnless(os.name == 'nt', 'Native Windows runtime counterexample')
    def test_existing_node_24_is_refused_before_watchdog_launch(self):
        node = Path(os.environ.get('P03_TEST_NODE_24', ''))
        if not node.is_file():
            self.skipTest('Existing Node24 counterexample is not installed')
        with tempfile.TemporaryDirectory(prefix='api-node-rejection-') as directory:
            root = Path(directory)
            (root / 'config.json').write_text(json.dumps({'host': '127.0.0.1', 'provider': 'simulated',
                'registryPython': sys.executable}), encoding='utf-8')
            (root / 'boot-runtime.json').write_text(json.dumps({'python': sys.executable,
                'node': str(node), 'docker': sys.executable, 'dockerConfig': str(root)}), encoding='utf-8')
            with self.assertRaises(RuntimeError):
                boot_watchdog.environment(root)

    @unittest.skipUnless(os.name == 'nt', 'Native Windows control command')
    def test_watchdog_child_is_isolated_and_does_not_write_bytecode(self):
        node = Path(os.environ.get('P03_TEST_NODE_22', ''))
        if not node.is_file():
            self.skipTest('Pinned Node fixture unavailable')
        with tempfile.TemporaryDirectory(prefix='api-cache-policy-') as directory:
            root = Path(directory)
            (root / 'config.json').write_text(json.dumps({'host': '127.0.0.1', 'provider': 'simulated',
                'registryPython': sys.executable}), encoding='utf-8')
            (root / 'boot-runtime.json').write_text(json.dumps({'python': sys.executable,
                'node': str(node), 'docker': sys.executable, 'dockerConfig': str(root)}), encoding='utf-8')
            (root / 'cache_fixture.py').write_text('value = 17\n', encoding='utf-8')
            (root / 'watchdog.py').write_text(
                'import json,sys\nfrom pathlib import Path\n'
                'root=Path(__file__).resolve().parent\nsys.path.insert(0,str(root))\n'
                'import cache_fixture\n'
                '(root/"probe.json").write_text(json.dumps({"isolated":sys.flags.isolated,"no_cache_write":sys.dont_write_bytecode,"loaded":cache_fixture.value}))\n', encoding='utf-8')
            self.assertEqual(boot_watchdog.main(root), 0)
            probe = json.loads((root / 'probe.json').read_text())
            self.assertEqual(probe['loaded'], 17)
            self.assertEqual(probe['isolated'], 1)
            self.assertTrue(probe['no_cache_write'])
            self.assertFalse((root / '__pycache__').exists())


if __name__ == '__main__':
    unittest.main()
