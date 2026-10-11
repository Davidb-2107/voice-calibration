from pathlib import Path
import shutil
import voice_calibration

root = Path(voice_calibration.__file__).parent
for name in ['provider_registry.py', 'provider_history.py', 'context.py', 'calibration.py', 'approval_gate.py', 'egress.py']:
    shutil.copyfile('/opt/provider-patch/' + name, root / 'core' / name)
source = Path('/opt/provider-patch/server.py').read_text()
original = 'if __name__ == "__main__":\n    main()'
assert source.count(original) == 1
replacement = ('if __name__ == "__main__":\n    import sys\n    sys.path.insert(0, "/opt/test-fixtures")\n'
               '    from chaos_worker import simulated_runner\n    _run_payload = simulated_runner\n    main()')
(root / 'mcp_server/server.py').write_text(source.replace(original, replacement))
