"""Trusted operator entry point. Never starts a candidate or initializes authority."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys

HERE = Path(__file__).resolve().parent
# -I ignores the candidate's CWD/PYTHONPATH; only this trusted control directory is added.
sys.path.insert(0, str(HERE))
from operator_runtime import operator_python
from release import financial_preflight, load_release


def verify_config(root, workspace_id=None, expected_config_sha256=None):
    root = Path(root).resolve()
    config_bytes = (root / 'config.json').read_bytes()
    config_hash = hashlib.sha256(config_bytes).hexdigest()
    if expected_config_sha256 is not None and config_hash != expected_config_sha256:
        raise RuntimeError('Operator configuration changed since composition')
    config = json.loads(config_bytes)
    interpreter = operator_python(config)
    if config.get('host') != '127.0.0.1' or config.get('provider') != 'simulated':
        raise RuntimeError('Only local simulated operator configuration is supported')
    directory = Path(config['releaseDir'])
    if not directory.is_absolute():
        raise RuntimeError('Absolute immutable release required')
    manifest = load_release(directory)
    if (Path(config['module']).resolve() != Path(manifest['module']).resolve()
            or config.get('commit') != manifest['releaseId']):
        raise RuntimeError('Actual API differs from the checked release')
    image = config.get('image')
    if type(image) is not str or not re.fullmatch(r'sha256:[a-f0-9]{64}', image):
        raise RuntimeError('Immutable engine image required')
    workspaces = config.get('workspaces')
    if type(workspaces) is not list or not workspaces:
        raise RuntimeError('Explicit guarded workspaces required')
    ids = [w['workspaceId'] for w in workspaces]
    if any(type(wid) is not str or not wid for wid in ids) or len(set(ids)) != len(ids):
        raise RuntimeError('Unique workspace identities required')
    if workspace_id is not None:
        if workspace_id not in ids:
            raise RuntimeError('Workspace is not registered in operator control')
        workspaces = [w for w in workspaces if w['workspaceId'] == workspace_id]
    for workspace in workspaces:
        control = Path(workspace['engine']['restoreGuardDir'])
        for path in [control / 'provider-registry/provider.sqlite3', control / 'provider-registry.key']:
            if path.is_symlink() or not path.is_file() or path.resolve().is_relative_to(directory.resolve()):
                raise RuntimeError('Existing independent provider authority required')
    financial_preflight(root, directory, config={**config, 'workspaces': workspaces})
    return {'schema': 'financial-preflight-v1', 'configSha256': config_hash,
            'operatorPython': interpreter, 'operatorVersion': list(sys.version_info[:3]),
            'workspaceIds': [w['workspaceId'] for w in workspaces],
            'artifactSha256': manifest['runtimeHash'], 'engineImage': image}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workspace')
    parser.add_argument('--expected-config-sha256')
    args = parser.parse_args()
    try:
        result = verify_config(HERE, args.workspace, args.expected_config_sha256)
    except (OSError, ValueError, KeyError, TypeError, RuntimeError) as error:
        raise SystemExit(f'Financial preflight refused: {error}') from error
    print(json.dumps(result))


if __name__ == '__main__':
    main()
