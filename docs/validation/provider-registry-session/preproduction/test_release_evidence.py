import json
from pathlib import Path
import tempfile
import unittest
import release


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);source=self.root/'source';(source/'dist').mkdir(parents=True)
        (source/'dist/index.js').write_text('fixture')
        (source/'package.json').write_text('{}')
        self.directory=release.stage(source,self.root,'base')

    def proof(self):
        return release.report(self.directory,'gates',{'status':'PASS','checks':dict.fromkeys(['node','browser','publication'],'PASS')})

    def test_matching_proof_passes_and_reports_are_immutable_per_run(self):
        first=self.proof();before=first.read_bytes();second=self.proof()
        self.assertNotEqual(first,second);self.assertEqual(first.read_bytes(),before)
        self.assertEqual(release.require_gates(self.directory,first)['module'],str(self.directory/'dist/index.js'))

    def test_old_release_cannot_authorize_new_release_even_with_same_content(self):
        proof=self.proof()
        other=release.stage(self.root/'source',self.root,'base')
        with self.assertRaisesRegex(RuntimeError,'another release'):release.require_gates(other,proof)

    def test_missing_browser_gate_blocks_activation(self):
        proof=release.report(self.directory,'gates',{'status':'PASS','checks':{'node':'PASS'}})
        with self.assertRaisesRegex(RuntimeError,'All release gates'):release.require_gates(self.directory,proof)

    def test_changed_compiled_content_invalidates_proof(self):
        proof=self.proof();(self.directory/'dist/index.js').write_text('changed')
        with self.assertRaisesRegex(RuntimeError,'identity mismatch'):release.require_gates(self.directory,proof)


if __name__=='__main__':unittest.main()
