"""Trace refusals without secrets; native failure fixtures never resume business."""
import contextlib
import ctypes
import io
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

import windows_candidate as native
import test_windows_candidate as fixtures


class TraceTests(unittest.TestCase):
    def refusal(self, error):
        root = Path(tempfile.mkdtemp(prefix='p03-trace-'))
        target = root / 'target.json'
        target.write_text('{}', encoding='utf-8')
        candidate = native.WindowsCandidate()
        candidate._manifest = target
        candidate.state = root
        candidate._profile = 'fixture'
        candidate.appcontainer_sid = 'fixture-sid'
        candidate.authority_identity = {'user_sid': 'fixture-user'}
        candidate.launches = 0
        candidate._check_authority = lambda: None
        candidate._load_payload = lambda: {'argv': ['SECRET_ARGUMENT'], 'env': {'SECRET_ENV': 'value'}, 'code': {}}
        candidate._snapshot = lambda locks: {}
        def spawn(*args):
            raise error
        candidate._api = types.SimpleNamespace(spawn=spawn, kernel=types.SimpleNamespace(CloseHandle=lambda handle: None))
        captured = io.StringIO()
        with contextlib.redirect_stderr(captured), self.assertRaises(RuntimeError) as refused:
            candidate.start()
        return captured.getvalue(), refused.exception

    def test_phase_and_chained_error_are_available_without_messages_or_arguments(self):
        cause = ValueError('SECRET_CAUSE')
        error = OSError('SECRET_MESSAGE')
        error.winerror = 5
        error.filename = 'SECRET_FILENAME'
        error.__cause__ = cause
        text, raised = self.refusal(error)
        self.assertIs(raised.__cause__, error)
        records = [json.loads(line) for line in text.splitlines()]
        failed = next((row for row in records if row['phase'] == 'start' and row['event'] == 'refused'), None)
        self.assertIsNotNone(failed, 'The original error is currently lost behind the generic refusal')
        self.assertEqual(failed['error_chain'], [
            {'type': 'RuntimeError', 'winerror': None},
            {'type': 'OSError', 'winerror': 5},
            {'type': 'ValueError', 'winerror': None},
        ])
        self.assertNotIn('SECRET_', text)
        self.assertTrue({'authority_check', 'manifest_read', 'code_snapshot', 'spawn'} <= {row['phase'] for row in records})
        allowed = {'schema', 'time_ns', 'pid', 'phase', 'event', 'candidate_pid', 'error_chain', 'chain_truncated'}
        self.assertTrue(all(set(row) <= allowed for row in records))

    def test_error_chain_is_bounded_even_when_cyclic(self):
        error = OSError('SECRET_CYCLE')
        error.__cause__ = error
        text, unused = self.refusal(error)
        records = [json.loads(line) for line in text.splitlines()]
        failed = next((row for row in records if row['phase'] == 'start' and row['event'] == 'refused'), None)
        self.assertIsNotNone(failed)
        self.assertLessEqual(len(failed['error_chain']), 8)
        self.assertTrue(failed['chain_truncated'])
        self.assertNotIn('SECRET_', text)

    def test_closed_diagnostic_pipe_preserves_the_original_decision(self):
        sink = types.SimpleNamespace(write=lambda text: (_ for _ in ()).throw(BrokenPipeError()),
                                     flush=lambda: None)
        error = RuntimeError('original refusal')
        with contextlib.redirect_stderr(sink), self.assertRaises(RuntimeError) as refused:
            with native._startup_phase('authority_check'):
                raise error
        self.assertIs(refused.exception, error)
        with contextlib.redirect_stderr(sink), native._startup_phase('authority_check'):
            pass


@unittest.skipUnless(sys.platform == 'win32', 'requires Windows AppContainer')
class NativeRefusalTraceTests(unittest.TestCase):
    candidate = fixtures.WindowsCandidateTests.candidate
    script = fixtures.WindowsCandidateTests.script

    def refusal(self, phase):
        candidate, node = self.candidate()
        marker = candidate.state / 'business.started'
        script = self.script(candidate, 'business.js',
            "const fs = require('node:fs'); fs.writeFileSync(" + json.dumps(str(marker)) + ", 'started');")
        candidate.qualify([str(node), '--preserve-symlinks', '--preserve-symlinks-main', str(script)])
        kernel = candidate._api.kernel
        original_create = kernel.CreateProcessW
        created = []
        def create(*args):
            if phase == 'CreateProcessW':
                ctypes.set_last_error(5)
                return False
            result = original_create(*args)
            if result:
                created.append(ctypes.cast(args[-1], ctypes.POINTER(native._ProcessInfo)).contents.pid)
            return result
        def denied(*args):
            ctypes.set_last_error(5)
            return False
        captured = io.StringIO()
        with patch.object(kernel, 'CreateProcessW', side_effect=create), \
             patch.object(kernel, 'AssignProcessToJobObject', side_effect=denied), \
             contextlib.redirect_stderr(captured), self.assertRaises(RuntimeError):
            candidate.start()
        records = [json.loads(line) for line in captured.getvalue().splitlines()]
        failure = next((row for row in records if row['phase'] == phase and row['event'] == 'refused'), None)
        self.assertIsNotNone(failure, 'The exact native refusal phase must survive')
        self.assertEqual(failure['error_chain'][0]['winerror'], 5)
        self.assertFalse(marker.exists(), 'Refused candidates must never enter business code')
        self.assertEqual(candidate.launches, 0)
        if phase == 'AssignProcessToJobObject':
            self.assertEqual(len(created), 1)
            from recover_owner import process_dead
            self.assertTrue(process_dead(created[0]), 'The suspended owned process must be reaped')

    def test_create_process_refusal_is_reported_before_business(self):
        self.refusal('CreateProcessW')

    def test_job_assignment_refusal_reaps_the_suspended_process(self):
        self.refusal('AssignProcessToJobObject')


if __name__ == '__main__':
    unittest.main()
