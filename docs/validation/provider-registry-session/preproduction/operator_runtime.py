"""Qualified operator runtime, checked before importing business modules."""
import sys

if sys.version_info[:2] != (3, 12):
    raise SystemExit('Operator runtime requires Python 3.12 before business imports')

from pathlib import Path


def operator_python(config):
    configured = config.get('registryPython')
    if (not isinstance(configured, str) or not Path(configured).is_absolute()
            or Path(configured).resolve() != Path(sys.executable).resolve()):
        raise RuntimeError('Configuration must use the same operator interpreter')
    return sys.executable
