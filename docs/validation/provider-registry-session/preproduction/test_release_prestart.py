"""Operator gates run before recovery, candidate import and every engine start."""
import json
import os
from pathlib import Path
import shutil
import shlex
import subprocess
import sys
import tempfile
import unittest

import release
import financial_preflight
from voice_calibration.core.provider_registry import ProviderRegistry

HERE = Path(__file__).resolve().parent


class InstalledPrestartTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="prestart-synthetic-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for path in HERE.iterdir():
            if path.suffix in (".py", ".mjs"):
                shutil.copyfile(path, self.root / path.name)
        with (self.root / "recover_owner.py").open("a") as stream:
            stream.write(
            "from pathlib import Path\n"
            "def recover(config):\n"
            " Path(__file__).with_name('recovery-called').write_text('unexpected')\n"
            " raise SystemExit(0)  # stop at the unit's recovery boundary\n")
        source = self.root / "source"
        (source / "dist").mkdir(parents=True)
        (source / "package.json").write_text('{"name":"synthetic-target","type":"module"}')
        (source / "dist/index.js").write_text("export const syntheticTarget = 1;\n")
        self.target = release.stage(source, self.root, "synthetic-base")
        manifest = release.load_release(self.target)
        control = self.root / "recovery/workspace-a"
        control.mkdir(parents=True)
        ProviderRegistry.initialize(control / "provider-registry", control / "provider-registry.key",
                                    "workspace-a", "tenant-a")
        (control / "guard.json").write_text(json.dumps({"version": 1, "workspace_id": "workspace-a", "state": "ready"}))
        self.config = {
            "host": "127.0.0.1", "provider": "simulated", "apiPort": 0, "healthPort": 0,
            "commit": manifest["releaseId"], "module": manifest["module"],
            "releaseDir": str(self.target), "image": "sha256:" + "a" * 64,
            "registryPython": sys.executable, "providerRegistryRequired": True,
            "windowsApiRoot": str(self.root / 'native-guard-unit-boundary'),
            "recoveryDir": str(self.root / "recovery"),
            "workspaces": [{"workspaceId": "workspace-a", "tenantId": "tenant-a",
                            "engine": {"restoreGuardDir": str(control)}}],
        }
        self.save_config()
        (self.root / 'boot-runtime.json').write_text(json.dumps({'node':sys.executable}))

    def save_config(self):
        (self.root / "config.json").write_text(json.dumps(self.config))

    def run_control(self):
        # Isolate the financial ordering guarantee. The real native program
        # seal and binary checks are covered by the AppContainer qualification.
        # Keep the actual financial reader and both configuration checks.
        probe = self.root / 'control-ordering-probe.py'
        probe.write_text(
            'import sys,runpy\nfrom pathlib import Path\n'
            'from contextlib import nullcontext\nfrom unittest.mock import patch\n'
            'root=Path(__file__).parent\nsys.path.insert(0,str(root))\n'
            'sys.argv=[str(root/"control.py"),"start"]\n'
            'with patch("node_runtime.pinned_node",return_value=sys.executable), '
            'patch("api_authority.operator_lock",return_value=nullcontext()):\n'
            ' runpy.run_path(str(root/"control.py"),run_name="__main__")\n')
        return subprocess.run([sys.executable,'-I','-B',str(probe)],cwd=self.root,
                              capture_output=True,text=True,timeout=20)

    def run_node(self, body):
        script = self.root / "probe.mjs"
        script.write_text("import { createFinancialPreflight } from './financial_preflight.mjs';\n"
                          "import { readFileSync, writeFileSync } from 'node:fs';\n"
                          "import { fileURLToPath } from 'node:url';\n"
                          "const root = fileURLToPath(new URL('.', import.meta.url));\n"
                          "const config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url)));\n"
                          + body)
        return subprocess.run(["node", str(script)], cwd=self.root, capture_output=True, text=True, timeout=20)

    def test_valid_legacy_authority_and_exact_workspace_are_checked(self):
        result = financial_preflight.verify_config(self.root, "workspace-a")
        self.assertEqual(result["workspaceIds"], ["workspace-a"])
        self.assertEqual(result["schema"], "financial-preflight-v1")
        with self.assertRaises(RuntimeError):
            financial_preflight.verify_config(self.root, "another-workspace")

    def test_missing_authority_is_not_initialized_by_a_check(self):
        registry = Path(self.config["workspaces"][0]["engine"]["restoreGuardDir"]) / "provider-registry/provider.sqlite3"
        registry.unlink()
        with self.assertRaises((RuntimeError, OSError)):
            financial_preflight.verify_config(self.root)
        self.assertFalse(registry.exists())

    def test_actual_module_cannot_differ_from_the_checked_release(self):
        self.config["module"] = str(self.root / "unattested.js")
        self.save_config()
        with self.assertRaises(RuntimeError):
            financial_preflight.verify_config(self.root)

    def test_modified_api_is_refused_before_recovery_or_popen(self):
        Path(self.config["module"]).write_text("export const changed = true;\n")
        result = self.run_control()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / "recovery-called").exists())
        self.assertFalse((self.root / "service.log").exists())

    def test_valid_legacy_target_reaches_the_recovery_boundary(self):
        # Positive control: the refusal test must not pass due to an earlier import/setup error.
        result = self.run_control()
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertTrue((self.root / "recovery-called").exists(), result.stderr)

    def test_node_adapter_runs_the_real_external_reader(self):
        result = self.run_node("await createFinancialPreflight(config, root)('workspace-a');\n")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_node_adapter_rejects_malformed_controller_output(self):
        (self.root / "financial_preflight.py").write_text("print('{}')\n")
        result = self.run_node("await createFinancialPreflight(config, root)('workspace-a');\n")
        self.assertNotEqual(result.returncode, 0)

    def test_node_adapter_rechecks_and_rejects_a_different_valid_target(self):
        source = self.root / "other-source"
        (source / "dist").mkdir(parents=True)
        (source / "package.json").write_text('{"name":"other-target","type":"module"}')
        (source / "dist/index.js").write_text("export const other = true;\n")
        other = release.stage(source, self.root, "synthetic-other")
        manifest = release.load_release(other)
        changed = {**self.config, "releaseDir": str(other), "module": manifest["module"], "commit": manifest["releaseId"]}
        result = self.run_node("const check = createFinancialPreflight(config, root);\n"
            "await check('workspace-a');\n"
            f"writeFileSync(new URL('./config.json', import.meta.url), JSON.stringify({json.dumps(changed)}));\n"
            "try { await check('workspace-a'); process.exitCode = 9; } catch { process.exitCode = 0; }\n")
        self.assertEqual(result.returncode, 0, result.stderr)

    def replacement_authority(self):
        control = self.root / 'replacement-control'
        control.mkdir()
        ProviderRegistry.initialize(control / 'provider-registry', control / 'provider-registry.key',
                                    'workspace-a', 'tenant-a')
        (control / 'guard.json').write_text(json.dumps({'version': 1, 'workspace_id': 'workspace-a', 'state': 'ready'}))
        return {**self.config, 'workspaces': [{'workspaceId': 'workspace-a', 'tenantId': 'tenant-a',
                                             'engine': {'restoreGuardDir': str(control)}}]}

    def test_node_adapter_refuses_same_workspace_rebound_to_another_valid_authority(self):
        changed = self.replacement_authority()
        result = self.run_node("const check = createFinancialPreflight(config, root);\n"
            "await check('workspace-a');\n"
            f"writeFileSync(new URL('./config.json', import.meta.url), JSON.stringify({json.dumps(changed)}));\n"
            "try { await check('workspace-a'); process.exitCode = 9; } catch { process.exitCode = 0; }\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        # The replacement itself is valid; refusing it must bind the original composition.
        self.assertEqual(financial_preflight.verify_config(self.root)['workspaceIds'], ['workspace-a'])

    def test_control_refuses_configuration_drift_during_recovery_before_popen(self):
        changed = self.replacement_authority()
        with (self.root / 'recover_owner.py').open('a') as stream:
            stream.write("def recover(config):\n"
                         f" Path(__file__).with_name('config.json').write_text({json.dumps(json.dumps(changed))})\n"
                         " return {'recovered': False}\n")
        result = self.run_control()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / 'service.log').exists(), result.stderr)

    def run_service(self, docker_body=None):
        binary = self.root / "bin/docker"
        binary.parent.mkdir(exist_ok=True)
        binary.write_text("#!/bin/sh\n" + (docker_body or "printf 'provider-registry\\n'\n"))
        binary.chmod(0o755)
        return subprocess.run(["node", str(self.root / "service.mjs"), str(self.root / "config.json")],
            cwd=self.root, env={**os.environ, "PATH": str(binary.parent) + os.pathsep + os.environ["PATH"]},
            capture_output=True, text=True, timeout=20)

    @unittest.skipIf(os.name == "nt", "POSIX Docker metadata shim; Windows deployment remains separately qualified")
    def test_service_wrapper_supplies_required_controller_to_the_api(self):
        source = self.root / "source"
        marker = self.root / "guarded-api-called"
        (source / "dist/index.js").write_text(
            "import { writeFileSync } from 'node:fs';\n"
            "export class DockerMcpStdioTransport { constructor(binding) { this.binding = binding; } }\n"
            "export async function startSupabaseCalibrationApi(options) {\n"
            " if (options.requireFinancialPreflight !== true) throw new Error('Guard not required');\n"
            " await options.financialPreflight('workspace-a');\n"
            f" writeFileSync({json.dumps(str(marker))}, 'guarded');\n"
            " throw new Error('Synthetic API end');\n}\n")
        self.target = release.stage(source, self.root, "synthetic-wrapper")
        manifest = release.load_release(self.target)
        self.config.update(releaseDir=str(self.target), module=manifest["module"], commit=manifest["releaseId"])
        self.save_config()
        self.run_service()
        self.assertTrue(marker.exists())

    @unittest.skipIf(os.name == "nt", "POSIX Docker metadata shim; Windows deployment remains separately qualified")
    def test_service_wrapper_refuses_changed_code_before_candidate_import(self):
        marker = self.root / "candidate-imported"
        Path(self.config["module"]).write_text(
            "import { writeFileSync } from 'node:fs';\n"
            f"writeFileSync({json.dumps(str(marker))}, 'unexpected');\n"
            "throw new Error('Candidate was imported');\n")
        result = self.run_service()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(marker.exists())

    @unittest.skipIf(os.name == 'nt', 'POSIX Docker metadata shim; Windows deployment remains separately qualified')
    def test_service_wrapper_rechecks_after_docker_inspection_before_import(self):
        marker = self.root / 'candidate-imported-during-inspection'
        changed = ("import { writeFileSync } from 'node:fs';\n"
                   f"writeFileSync({json.dumps(str(marker))}, 'unexpected');\n"
                   "throw new Error('Unverified candidate was imported');\n")
        result = self.run_service('printf %s ' + shlex.quote(changed) + ' > '
                                  + shlex.quote(self.config['module']) + "\nprintf 'provider-registry\\n'\n")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(marker.exists(), result.stderr)


if __name__ == "__main__":
    unittest.main()
