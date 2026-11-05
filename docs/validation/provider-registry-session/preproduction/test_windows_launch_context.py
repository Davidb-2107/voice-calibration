"""Regression coverage for S4U desktop setup and native resource ownership."""
import ctypes
from contextlib import ExitStack, redirect_stderr
import io
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from windows_candidate import RunningCandidate, _Windows


class DesktopContextTests(unittest.TestCase):
    def setUp(self):
        self.session = 0
        self.events = []
        self.native = object.__new__(_Windows)

        def process_session(pid, output):
            output._obj.value = self.session
            return True

        def check(result):
            if not result:
                error = OSError('simulated native refusal')
                error.winerror = 5
                raise error
            return result

        self.native.check = check
        self.native.kernel = SimpleNamespace(
            ProcessIdToSessionId=Mock(side_effect=process_session),
            LocalFree=Mock(),
        )
        self.native.security = SimpleNamespace(
            ConvertStringSecurityDescriptorToSecurityDescriptorW=Mock(return_value=True),
        )
        self.user32 = SimpleNamespace(
            GetProcessWindowStation=Mock(return_value=10),
            CreateWindowStationW=Mock(return_value=20),
            SetProcessWindowStation=Mock(return_value=True),
            CreateDesktopW=Mock(return_value=30),
            CloseDesktop=Mock(side_effect=lambda handle: self.events.append(('desktop', handle)) or True),
            CloseWindowStation=Mock(side_effect=lambda handle: self.events.append(('station', handle)) or True),
        )
        self.addCleanup(patch.stopall)
        self.loader = patch.object(ctypes, 'WinDLL', return_value=self.user32, create=True).start()
        patch.object(ctypes, 'set_last_error', create=True).start()
        patch.object(ctypes, 'get_last_error', return_value=0, create=True).start()

    def test_interactive_session_keeps_existing_desktop(self):
        self.session = 1
        name, resources = self.native.private_desktop('fixture-user', 'fixture-app')
        self.assertIsNone(name)
        resources.close()
        self.loader.assert_not_called()

    def test_s4u_uses_new_objects_with_only_its_authority_and_app(self):
        name, resources = self.native.private_desktop('fixture-user', 'fixture-app')
        self.assertTrue(name.endswith('\\Candidate'))
        self.assertEqual(self.user32.SetProcessWindowStation.call_args_list[0].args, (20,))
        self.assertEqual(self.user32.SetProcessWindowStation.call_args_list[-1].args, (10,))
        descriptors = [call.args[0] for call in
                       self.native.security.ConvertStringSecurityDescriptorToSecurityDescriptorW.call_args_list]
        self.assertEqual(len(descriptors), 2)
        for descriptor in descriptors:
            self.assertIn('O:fixture-userD:P', descriptor)
            self.assertIn('(A;;GA;;;fixture-user)', descriptor)
            self.assertIn(';;;fixture-app)', descriptor)
            self.assertIn('S:(ML;;NW;;;LW)', descriptor)
            self.assertNotIn(';;;WD)', descriptor)
            self.assertNotIn(';;;AC)', descriptor)
        self.assertEqual(self.events, [])
        resources.close()
        resources.close()
        self.assertEqual(self.events, [('desktop', 30), ('station', 20)])

    def test_desktop_refusal_restores_parent_and_closes_station(self):
        self.user32.CreateDesktopW.return_value = None
        with self.assertRaises(OSError):
            self.native.private_desktop('fixture-user', 'fixture-app')
        self.assertEqual(self.user32.SetProcessWindowStation.call_args_list[-1].args, (10,))
        self.assertEqual(self.events, [('station', 20)])

    def test_existing_station_is_rejected_and_closed(self):
        patch.object(ctypes, 'get_last_error', return_value=183, create=True).start()
        with self.assertRaises(RuntimeError):
            self.native.private_desktop('fixture-user', 'fixture-app')
        self.user32.CreateDesktopW.assert_not_called()
        self.assertEqual(self.events, [('station', 20)])


class DesktopLifetimeTests(unittest.TestCase):
    def test_process_exit_releases_job_before_desktop_resources(self):
        events = []

        def exit_code(process, output):
            output._obj.value = 0
            return True

        kernel = SimpleNamespace(
            WaitForSingleObject=Mock(return_value=0),
            GetExitCodeProcess=Mock(side_effect=exit_code),
            CloseHandle=Mock(side_effect=lambda handle: events.append(('handle', handle))),
        )
        resources = ExitStack()
        resources.callback(lambda: events.append(('desktop', 'closed')))
        native = SimpleNamespace(kernel=kernel, check=lambda result: result)
        process = RunningCandidate(native, 10, 20, 30, {}, [Mock(), Mock(), Mock()], [], resources)
        self.assertEqual(process.wait(1), 0)
        self.assertEqual(events, [('handle', 20), ('desktop', 'closed')])
        process.close()
        process.close()
        self.assertEqual(events.count(('desktop', 'closed')), 1)


class ProfileContextTests(unittest.TestCase):
    def setUp(self):
        self.native = object.__new__(_Windows)
        self.native.userenv = SimpleNamespace(
            CreateAppContainerProfile=Mock(return_value=0x800700b7),
            DeriveAppContainerSidFromAppContainerName=Mock(side_effect=RuntimeError('derivation reached')),
        )
        self.native.security = SimpleNamespace(FreeSid=Mock())
        self.native.kernel = Mock()
        self.native.sid_text = Mock(return_value='wrong-app')

    def start(self):
        with patch.dict(sys.modules, {'msvcrt': SimpleNamespace()}), redirect_stderr(io.StringIO()):
            self.native.spawn(['fixture'], {}, Path('fixture'), 'fixture-profile', 'expected-app', {}, [])

    def test_registration_failure_prevents_native_creation(self):
        self.native.userenv.CreateAppContainerProfile.return_value = 0x80070005
        with self.assertRaisesRegex(RuntimeError, 'Cannot register qualified AppContainer'):
            self.start()
        self.native.userenv.DeriveAppContainerSidFromAppContainerName.assert_not_called()
        self.native.kernel.CreateProcessW.assert_not_called()

    def test_existing_profile_is_registered_before_derivation(self):
        with self.assertRaisesRegex(RuntimeError, 'derivation reached'):
            self.start()
        self.native.userenv.CreateAppContainerProfile.assert_called_once()
        self.native.userenv.DeriveAppContainerSidFromAppContainerName.assert_called_once()
        self.native.kernel.CreateProcessW.assert_not_called()

    def test_changed_registered_identity_is_freed_and_refused(self):
        def register(*arguments):
            arguments[-1]._obj.value = 123
            return 0

        self.native.userenv.CreateAppContainerProfile.side_effect = register
        with self.assertRaisesRegex(RuntimeError, 'Registered AppContainer identity changed'):
            self.start()
        self.native.security.FreeSid.assert_called_once()
        self.native.userenv.DeriveAppContainerSidFromAppContainerName.assert_not_called()
        self.native.kernel.CreateProcessW.assert_not_called()


if __name__ == '__main__':
    unittest.main()
