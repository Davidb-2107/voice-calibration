"""Verify independent journals without exposing credentials or signing keys."""
import json
from pathlib import Path
import sys
from application.provider_registry import ProviderRegistry, ProviderRegistryBlocked


def verify(config):
    if not config.get('providerRegistryRequired'):
        return {'valid': False, 'reason': 'provider_registry_required'}
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
