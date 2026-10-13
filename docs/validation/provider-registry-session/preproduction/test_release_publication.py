import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import install_provider_registry as installer


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root/'data/queue').mkdir(parents=True)
        (self.root/'recovery').mkdir()
        self.config = {'host':'127.0.0.1','provider':'simulated','image':'old',
                       'jobQueue':{'dataDir':str(self.root/'data/queue')},
                       'recoveryDir':str(self.root/'recovery'),'workspaces':[]}
        (self.root/'config.json').write_text(json.dumps(self.config))
        self.owner=self.root/'data/queue/owner.lock';self.lock=self.root/'recovery/restore.lock'
        for context in [patch.object(installer,'HERE',self.root),
                        patch.object(installer.subprocess,'check_output',return_value='')]:
            context.start();self.addCleanup(context.stop)

    def test_new_workspace_is_validated_before_claims_and_published_once(self):
        guard=self.root/'recovery/new';guard.mkdir()
        (guard/'guard.json').write_text(json.dumps({'workspace_id':'new','state':'ready'}))
        candidate=copy.deepcopy(self.config)
        candidate['workspaces']=[{'tenantId':'new','workspaceId':'new','engine':{'restoreGuardDir':str(guard)}}]
        validate=installer.validate
        def before_claims(config):
            self.assertFalse(self.owner.exists());self.assertFalse(self.lock.exists())
            validate(config)
        with patch.object(installer,'validate',side_effect=before_claims):
            installer.install(candidate)
        self.assertEqual(json.loads((self.root/'config.json').read_text()),candidate)
        self.assertFalse(self.owner.exists());self.assertFalse(self.lock.exists())
        installer.install(candidate)
        self.assertEqual(len(json.loads((self.root/'config.json').read_text())['workspaces']),1)

    def test_invalid_candidate_never_acquires_claims_or_changes_config(self):
        candidate={**self.config,'provider':'elevenlabs'}
        with self.assertRaises(RuntimeError):installer.install(candidate)
        self.assertFalse(self.owner.exists());self.assertFalse(self.lock.exists())
        self.assertEqual(json.loads((self.root/'config.json').read_text()),self.config)

    def test_interruption_keeps_equal_claims_and_old_config_and_blocks_retry(self):
        with patch.object(installer,'write_record',side_effect=RuntimeError('interrupted')):
            with self.assertRaises(RuntimeError):installer.install({**self.config,'image':'new'})
        self.assertEqual(json.loads(self.owner.read_text()),json.loads(self.lock.read_text()))
        self.assertEqual(json.loads((self.root/'config.json').read_text()),self.config)
        with self.assertRaises(RuntimeError):installer.install({**self.config,'image':'new'})

    def test_active_engine_blocks_publication_and_preserves_config(self):
        rows=[{'Mounts':[{'Source':str(self.root/'data/existing')}]}]
        with patch.object(installer.subprocess,'check_output',side_effect=['container',json.dumps(rows)]):
            with self.assertRaisesRegex(RuntimeError,'engines must be stopped'):
                installer.install({**self.config,'image':'new'})
        self.assertEqual(json.loads((self.root/'config.json').read_text()),self.config)

    def test_publication_cannot_move_queue_or_remove_existing_workspace(self):
        with self.assertRaisesRegex(RuntimeError,'preserve installation'):
            installer.install({**self.config,'jobQueue':{'dataDir':str(self.root/'other/queue')}})
        guard=self.root/'recovery/old';guard.mkdir()
        (guard/'guard.json').write_text(json.dumps({'workspace_id':'old','state':'quarantined'}))
        self.config['workspaces']=[{'tenantId':'old','workspaceId':'old','engine':{'restoreGuardDir':str(guard)}}]
        (self.root/'config.json').write_text(json.dumps(self.config))
        with self.assertRaisesRegex(RuntimeError,'existing workspace'):
            installer.install({**self.config,'workspaces':[]})


if __name__=='__main__':unittest.main()
