"""Windows integration checks with a real, copied Node runtime.

Run with P03_WINDOWS_NODE pointing to the approved, copyable Node executable.
Fixture directories and AppContainer profiles are intentionally retained. Set
P03_WINDOWS_FIXTURE_ROOT to choose their parent, and P03_WINDOWS_RECORD_DIR to
write evidence without recording authority key contents.

These tests exercise local process isolation, not provider authorization or a
complete MCP transport. The import-time marker models business initialization.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
import uuid
from unittest.mock import patch


@unittest.skipUnless(sys.platform == "win32", "requires Windows AppContainer")
class WindowsCandidateTests(unittest.TestCase):
    def candidate(self):
        # Import here so non-Windows collection needs no Win32 dependencies.
        from windows_candidate import WindowsCandidate

        configured = os.environ.get("P03_WINDOWS_NODE")
        self.assertTrue(configured, "set P03_WINDOWS_NODE to the approved Node runtime")
        runtime = Path(configured)
        self.assertTrue(runtime.is_absolute(), "P03_WINDOWS_NODE must be absolute")
        self.assertTrue(runtime.is_file(), "P03_WINDOWS_NODE must name an executable")
        parent = Path(os.environ.get(
            "P03_WINDOWS_FIXTURE_ROOT",
            str(Path(tempfile.gettempdir()) / "p03-windows-candidate-fixtures"),
        ))
        parent.mkdir(parents=True, exist_ok=True)
        self.fixture_id = f"{self._testMethodName}-{uuid.uuid4().hex}"
        candidate = WindowsCandidate.create(parent / self.fixture_id)
        node = candidate.code / "node.exe"
        shutil.copy2(runtime, node)
        return candidate, node

    @staticmethod
    def digest(path):
        return hashlib.sha256(path.read_bytes()).hexdigest()

    def script(self, candidate, name, source):
        path = candidate.code / name
        path.write_text(source, encoding="utf-8")
        return path

    def record(self, candidate, **evidence):
        target = os.environ.get("P03_WINDOWS_RECORD_DIR")
        if not target:
            return
        parent = Path(target)
        parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "test": self._testMethodName,
            "fixture": str(candidate.code.parent),
            "appcontainer_sid": candidate.appcontainer_sid,
            "authority_identity": candidate.authority_identity,
            "launches": candidate.launches,
            **evidence,
        }
        (parent / f"{self.fixture_id}.json").write_text(
            json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8"
        )

    def execute(self, candidate):
        with candidate.start() as process:
            output, errors = process.communicate(timeout=15)
            self.assertEqual(process.returncode, 0, errors.decode("utf-8", "replace"))
            return process.pid, process.identity, json.loads(output)

    def test_intact_candidate_runs_with_distinct_appcontainer_identity(self):
        """An ordinary host token, even under the same user, must fail here."""
        candidate, node = self.candidate()
        marker = candidate.state / "business.started"
        script = self.script(candidate, "business.js", (
            "const fs = require('node:fs');\n"
            f"fs.writeFileSync({json.dumps(str(marker))}, 'started');\n"
            "console.log(JSON.stringify({business: 'started'}));\n"
        ))
        candidate.qualify([str(node), '--preserve-symlinks', '--preserve-symlinks-main', str(script)])

        pid, identity, response = self.execute(candidate)

        self.assertGreater(pid, 0)
        self.assertTrue(identity["is_appcontainer"])
        self.assertEqual(identity["appcontainer_sid"], candidate.appcontainer_sid)
        self.assertEqual(identity["integrity_sid"], "S-1-16-4096")
        self.assertFalse(candidate.authority_identity["is_appcontainer"])
        self.assertNotEqual(
            identity["appcontainer_sid"],
            candidate.authority_identity.get("appcontainer_sid"),
        )
        # The account SID can be shared. The AppContainer SID is the boundary.
        self.assertTrue(identity["user_sid"])
        self.assertEqual(response, {"business": "started"})
        self.assertEqual(marker.read_text(), "started")
        self.assertEqual(candidate.launches, 1)
        self.record(candidate, pid=pid, identity=identity, business_started=True)

    def test_authority_key_read_is_denied_before_business_initialization(self):
        """Granting the candidate key-read access must fail this test."""
        candidate, node = self.candidate()
        marker = candidate.state / "business.started"
        script = self.script(candidate, "read-authority.js", (
            "const fs = require('node:fs');\n"
            "try {\n"
            f"  const fd = fs.openSync({json.dumps(str(candidate.authority_key))}, 'r');\n"
            "  fs.readFileSync(fd); fs.closeSync(fd);\n"
            "} catch (error) {\n"
            "  console.log(JSON.stringify({denied: error.code}));\n"
            "  process.exit(0);\n"
            "}\n"
            f"fs.writeFileSync({json.dumps(str(marker))}, 'started');\n"
            "console.log(JSON.stringify({business: 'started'}));\n"
        ))
        candidate.qualify([str(node), '--preserve-symlinks', '--preserve-symlinks-main', str(script)])
        self.assertTrue(candidate.authority_key.is_file())

        pid, identity, response = self.execute(candidate)

        self.assertIn(response.get("denied"), {"EACCES", "EPERM"})
        self.assertFalse(marker.exists(), "business continued after authority-key refusal")
        self.record(candidate, pid=pid, identity=identity,
                    refusal=response, business_started=False)

    def test_qualified_source_append_is_denied_before_business_initialization(self):
        """Giving the candidate write access to qualified code must fail here."""
        candidate, node = self.candidate()
        marker = candidate.state / "business.started"
        script = candidate.code / "append-source.js"
        self.script(candidate, script.name, (
            "const fs = require('node:fs');\n"
            "try {\n"
            f"  fs.appendFileSync({json.dumps(str(script))}, '\\n// altered');\n"
            "} catch (error) {\n"
            "  console.log(JSON.stringify({denied: error.code}));\n"
            "  process.exit(0);\n"
            "}\n"
            f"fs.writeFileSync({json.dumps(str(marker))}, 'started');\n"
            "console.log(JSON.stringify({business: 'started'}));\n"
        ))
        candidate.qualify([str(node), '--preserve-symlinks', '--preserve-symlinks-main', str(script)])
        expected_hash = self.digest(script)

        pid, identity, response = self.execute(candidate)

        self.assertIn(response.get("denied"), {"EACCES", "EPERM"})
        self.assertEqual(self.digest(script), expected_hash)
        self.assertFalse(marker.exists(), "business continued after code-write refusal")
        self.record(candidate, pid=pid, identity=identity, refusal=response,
                    source_sha256=expected_hash, business_started=False)

    def test_tampered_mcp_module_is_refused_before_import(self):
        """Removing prelaunch dependency verification must fail this test."""
        candidate, node = self.candidate()
        marker = candidate.state / "business.started"
        module = self.script(candidate, "mcp-business.js", "exports.ready = true;\n")
        script = self.script(candidate, "entry.js", (
            "require('./mcp-business.js');\n"
            "console.log(JSON.stringify({ready: true}));\n"
        ))
        candidate.qualify([str(node), '--preserve-symlinks', '--preserve-symlinks-main', str(script)])
        original_hash = self.digest(module)
        # The trusted test operator simulates drift after qualification.
        module.write_text(
            "require('node:fs').writeFileSync("
            f"{json.dumps(str(marker))}, 'imported');\n",
            encoding="utf-8",
        )
        self.assertNotEqual(self.digest(module), original_hash)

        with self.assertRaises(RuntimeError):
            candidate.start()

        self.assertEqual(candidate.launches, 0)
        self.assertFalse(marker.exists(), "tampered module executed during launch validation")
        self.record(candidate, original_module_sha256=original_hash,
                    altered_module_sha256=self.digest(module),
                    refusal="RuntimeError", business_started=False)

    def test_unqualified_candidate_cannot_start(self):
        candidate, _ = self.candidate()

        with self.assertRaises(RuntimeError):
            candidate.start()

        self.assertEqual(candidate.launches, 0)
        self.record(candidate, refusal="RuntimeError", business_started=False)

    def test_reopened_authority_preserves_isolation_and_fixed_command(self):
        from windows_candidate import WindowsCandidate
        candidate, node = self.candidate()
        script = self.script(candidate, 'reconnect.js',
                             'console.log(JSON.stringify({reconnected: true}));\n')
        candidate.qualify([str(node), '--preserve-symlinks', '--preserve-symlinks-main', str(script)])
        reopened = WindowsCandidate.open(candidate.code.parent)
        pid, identity, response = self.execute(reopened)
        self.assertEqual(response, {'reconnected': True})
        self.assertEqual(identity['appcontainer_sid'], candidate.appcontainer_sid)
        self.assertEqual(reopened.authority_identity, candidate.authority_identity)
        self.record(reopened, pid=pid, identity=identity, fixed_command_preserved=True)

    def test_invalid_manifest_signature_is_refused_without_business_start(self):
        candidate, node = self.candidate()
        marker = candidate.state/'business.started'
        script = self.script(candidate, 'manifest.js',
                             f'require("node:fs").writeFileSync({json.dumps(str(marker))}, "started");\n')
        candidate.qualify([str(node), '--preserve-symlinks', '--preserve-symlinks-main', str(script)])
        path = candidate.code.parent/'authority/target.json'
        record = json.loads(path.read_text())
        record['signature'] = '0'*64
        path.write_text(json.dumps(record))
        with self.assertRaises(RuntimeError):
            candidate.start()
        self.assertEqual(candidate.launches, 0)
        self.assertFalse(marker.exists())
        self.record(candidate, invalid_signature_refused=True, business_started=False)

    def test_operator_cli_relays_intact_candidate_and_refuses_drift_on_reconnect(self):
        import windows_candidate
        candidate, node = self.candidate()
        marker = candidate.state/'business.started'
        script = self.script(candidate, 'cli.js',
                             'console.log(JSON.stringify({cli: true}));\n')
        candidate.qualify([str(node), '--preserve-symlinks', '--preserve-symlinks-main', str(script)])
        command = [sys.executable, '-I', '-B', str(Path(windows_candidate.__file__)), 'run', str(candidate.code.parent)]
        result = subprocess.run(command, input=b'', capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr.decode('utf-8','replace'))
        self.assertEqual(json.loads(result.stdout), {'cli': True})
        script.write_text(f'require("node:fs").writeFileSync({json.dumps(str(marker))},"started");\n')
        refused = subprocess.run(command, input=b'', capture_output=True, timeout=20)
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn(b'changed', refused.stderr)
        self.assertEqual(refused.stdout, b'')
        self.assertFalse(marker.exists())
        self.record(candidate, command=command, initial_exit=result.returncode,
                    refused_exit=refused.returncode, refusal=refused.stderr.decode(), business_started=False)

    def test_executable_outside_qualified_code_is_refused(self):
        candidate, _ = self.candidate()
        external_runtime = Path(os.environ["P03_WINDOWS_NODE"])
        marker = candidate.state / "business.started"
        script = self.script(candidate, "entry.js", (
            "require('node:fs').writeFileSync("
            f"{json.dumps(str(marker))}, 'started');\n"
        ))

        with self.assertRaises(RuntimeError):
            candidate.qualify([str(external_runtime), '--preserve-symlinks', '--preserve-symlinks-main', str(script)])

        self.assertEqual(candidate.launches, 0)
        self.assertFalse(marker.exists())
        self.record(candidate, refusal="RuntimeError", business_started=False)

    def test_writable_state_cannot_supply_the_business_entrypoint(self):
        candidate, node = self.candidate()
        script = candidate.state/'mutable-business.js'
        script.write_text('console.log("unqualified business");\n')
        with self.assertRaises(RuntimeError):
            candidate.qualify([str(node), '--preserve-symlinks', '--preserve-symlinks-main', str(script)])
        self.assertEqual(candidate.launches, 0)
        self.record(candidate, mutable_entry_refused=True, business_started=False)

    def test_ntfs_stream_cannot_supply_the_business_entrypoint(self):
        candidate, node = self.candidate()
        carrier = candidate.code/'carrier.txt'
        carrier.write_text('carrier')
        stream = Path(str(carrier)+':entry.js')
        stream.write_text('console.log("unqualified stream");\n')
        with self.assertRaises(RuntimeError):
            candidate.qualify([str(node), '--preserve-symlinks', '--preserve-symlinks-main', str(stream)])
        self.assertEqual(candidate.launches, 0)
        self.record(candidate, ntfs_stream_entry_refused=True, business_started=False)

    def test_ntfs_stream_added_after_qualification_prevents_business_start(self):
        candidate, node = self.candidate()
        marker = candidate.state/'business.started'
        carrier = candidate.code/'carrier.txt'
        carrier.write_text('unchanged default stream')
        script = self.script(candidate, 'entry.js',
                             f'require("node:fs").writeFileSync({json.dumps(str(marker))}, "started");\n')
        candidate.qualify([str(node), '--preserve-symlinks', '--preserve-symlinks-main', str(script)])
        original = self.digest(carrier)
        Path(str(carrier)+':hidden.py').write_text('unhashed executable payload')
        self.assertEqual(self.digest(carrier), original)
        with self.assertRaises(RuntimeError):
            with candidate.start() as process:
                process.communicate(timeout=10)
        self.assertEqual(candidate.launches, 0)
        self.assertFalse(marker.exists())
        self.record(candidate, ntfs_dependency_stream_refused=True, business_started=False)

    def test_hardlinked_file_is_refused_before_changing_outside_protection(self):
        candidate, node = self.candidate()
        outside = candidate.state/'outside-code.js'
        outside.write_text('console.log("hardlink");\n')
        script = candidate.code/'linked.js'
        os.link(outside, script)
        self.assertGreater(script.stat().st_nlink, 1)
        with self.assertRaises(RuntimeError):
            candidate.qualify([str(node), '--preserve-symlinks', '--preserve-symlinks-main', str(script)])
        self.assertEqual(candidate.launches, 0)
        self.record(candidate, hardlink_refused=True, business_started=False)

    def test_communicate_timeout_covers_a_full_input_pipe(self):
        candidate, node = self.candidate()
        script = self.script(candidate, 'not-reading.js', 'setTimeout(()=>{},30000);\n')
        candidate.qualify([str(node), '--preserve-symlinks', '--preserve-symlinks-main', str(script)])
        result = {}
        with candidate.start() as process:
            def communicate():
                try:
                    process.communicate(input=b'x'*1_000_000, timeout=0.25)
                except BaseException as error:
                    result['error'] = error
            thread = threading.Thread(target=communicate, daemon=True)
            thread.start()
            thread.join(2)
            deadline_respected = not thread.is_alive()
            if not deadline_respected:
                process.kill()  # Only the owned fixture job, to keep RED bounded.
                thread.join(5)
            self.assertTrue(deadline_respected, 'timeout did not cover blocking stdin write')
            self.assertIsInstance(result.get('error'), subprocess.TimeoutExpired)
        self.record(candidate, input_timeout_respected=True)

    def test_native_profile_failure_does_not_start_or_reuse_a_candidate(self):
        import windows_candidate as module
        parent = Path(os.environ['P03_WINDOWS_FIXTURE_ROOT'])
        root = parent/('profile-failure-'+uuid.uuid4().hex)
        api = module._Windows()
        with patch.object(api.userenv, 'CreateAppContainerProfile', return_value=-2147024891), \
             patch.object(module, '_Windows', return_value=api):
            with self.assertRaisesRegex(RuntimeError, 'Cannot create a fresh AppContainer'):
                module.WindowsCandidate.create(root)
        self.assertFalse((root/'profile.json').exists())
        self.assertFalse((root/'authority/qualification.key').exists())

    def test_changed_key_acl_refuses_reopening_before_business(self):
        from windows_candidate import WindowsCandidate
        candidate, node = self.candidate()
        marker = candidate.state/'business.started'
        script = self.script(candidate, 'acl.js',
                             f'require("node:fs").writeFileSync({json.dumps(str(marker))}, "started");\n')
        candidate.qualify([str(node), '--preserve-symlinks', '--preserve-symlinks-main', str(script)])
        result = subprocess.run([str(Path(os.environ['SYSTEMROOT'])/'System32/icacls.exe'),
                                 str(candidate.authority_key), '/inheritance:e'], capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr.decode('utf-8','replace'))
        with self.assertRaises(RuntimeError):
            WindowsCandidate.open(candidate.code.parent)
        self.assertEqual(candidate.launches, 0)
        self.assertFalse(marker.exists())
        self.record(candidate, key_acl_drift_refused=True, business_started=False)

    def test_wrong_native_token_is_terminated_while_still_suspended(self):
        import ctypes
        import windows_candidate as module
        candidate, node = self.candidate()
        marker = candidate.state/'business.started'
        script = self.script(candidate, 'wrong-token.js',
                             f'require("node:fs").writeFileSync({json.dumps(str(marker))}, "started");\n')
        candidate.qualify([str(node), '--preserve-symlinks', '--preserve-symlinks-main', str(script)])
        original = candidate._api.kernel.CreateProcessW
        def wrong_token(executable, command, process_security, thread_security, inherit,
                        flags, environment, cwd, startup, information):
            # Fault injection: really create the owned process with a normal
            # token, preserving CREATE_SUSPENDED. The guard must never resume it.
            value = ctypes.cast(startup, ctypes.POINTER(module._StartupEx)).contents
            value.startup.cb = ctypes.sizeof(module._Startup)
            return original(executable, command, process_security, thread_security, inherit,
                            flags & ~0x80000, environment, cwd, startup, information)
        with patch.object(candidate._api.kernel, 'CreateProcessW', side_effect=wrong_token):
            with self.assertRaisesRegex(RuntimeError, 'token does not match'):
                candidate.start()
        self.assertEqual(candidate.launches, 0)
        self.assertFalse(marker.exists())
        self.record(candidate, wrong_native_token_refused=True, business_started=False)

    def test_ntfs_junction_is_refused_before_following_it(self):
        import ctypes
        from ctypes import wintypes
        import struct
        candidate, node = self.candidate()
        script = self.script(candidate, 'junction.js', 'console.log("unexpected");\n')
        junction = candidate.code/'outside-junction'
        junction.mkdir()
        substitute = ('\\??\\'+str(candidate.state)).encode('utf-16-le')
        printable = str(candidate.state).encode('utf-16-le')
        paths = substitute+b'\0\0'+printable+b'\0\0'
        data = struct.pack('<IHHHHHH',0xA0000003,8+len(paths),0,0,len(substitute),len(substitute)+2,len(printable))+paths
        kernel = ctypes.WinDLL('kernel32',use_last_error=True)
        kernel.CreateFileW.argtypes=[wintypes.LPCWSTR,wintypes.DWORD,wintypes.DWORD,ctypes.c_void_p,wintypes.DWORD,wintypes.DWORD,wintypes.HANDLE]
        kernel.CreateFileW.restype=wintypes.HANDLE
        kernel.DeviceIoControl.argtypes=[wintypes.HANDLE,wintypes.DWORD,ctypes.c_void_p,wintypes.DWORD,ctypes.c_void_p,wintypes.DWORD,ctypes.POINTER(wintypes.DWORD),ctypes.c_void_p]
        kernel.CloseHandle.argtypes=[wintypes.HANDLE]
        handle=kernel.CreateFileW(str(junction),0x40000000,7,None,3,0x2200000,None)
        self.assertNotEqual(handle,ctypes.c_void_p(-1).value)
        try:
            returned=wintypes.DWORD()
            buffer=ctypes.create_string_buffer(data)
            self.assertTrue(kernel.DeviceIoControl(handle,0x900A4,buffer,len(data),None,0,ctypes.byref(returned),None),ctypes.get_last_error())
        finally:
            kernel.CloseHandle(handle)
        self.assertTrue(junction.stat(follow_symlinks=False).st_file_attributes & 0x400)
        with self.assertRaises(RuntimeError):
            candidate.qualify([str(node), '--preserve-symlinks', '--preserve-symlinks-main', str(script)])
        self.assertEqual(candidate.launches,0)
        self.record(candidate, real_junction_refused=True, business_started=False)


if __name__ == "__main__":
    unittest.main()
