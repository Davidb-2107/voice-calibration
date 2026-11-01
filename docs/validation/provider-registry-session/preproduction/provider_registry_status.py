"""Verify independent journals without exposing credentials or signing keys."""
import json
from pathlib import Path
import sys
if __name__ == '__main__' and (not sys.flags.isolated or not sys.dont_write_bytecode
        or (Path(__file__).resolve().parent / '__pycache__').exists()
        or list(Path(__file__).resolve().parent.glob('*.pyc'))):
    raise RuntimeError('Registry reader requires Python 3.12 with -I -B and source-only operator imports')
sys.path.insert(0, str(Path(__file__).resolve().parent))
from operator_runtime import operator_python
from voice_calibration.core.provider_registry import ProviderRegistry, ProviderRegistryBlocked


def verify(config):
    if not config.get('providerRegistryRequired'):
        return {'valid': False, 'reason': 'provider_registry_required'}
    operator_python(config)
    try:
        for workspace in config['workspaces']:
            control = Path(workspace['engine']['restoreGuardDir'])
            ProviderRegistry(control / 'provider-registry', control / 'provider-registry.key',
                             workspace['workspaceId'], workspace['tenantId']).records()
    except (ProviderRegistryBlocked, OSError, ValueError, KeyError):
        return {'valid': False, 'reason': 'provider_registry_invalid'}
    return {'valid': True, 'workspaces': len(config['workspaces'])}


if __name__ == '__main__':
    config = json.loads(Path(sys.argv[1]).read_text())
    print(json.dumps(verify(config)))
