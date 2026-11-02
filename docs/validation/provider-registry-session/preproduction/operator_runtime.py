"""Qualified operator runtime, checked before importing business modules."""
import sys

if sys.version_info[:2] != (3, 12):
    raise SystemExit('Operator runtime requires Python 3.12 before business imports')

from pathlib import Path
from importlib.machinery import ExtensionFileLoader, EXTENSION_SUFFIXES, FileFinder, SourceFileLoader, SOURCE_SUFFIXES


class _SourceOnlyLoader(SourceFileLoader):
    def get_code(self, fullname):
        filename = self.get_filename(fullname)
        return self.source_to_code(self.get_data(filename), filename)


_qualified_roots = (Path(__file__).resolve().parent, Path(sys.executable).resolve().parent)
_source_finder = FileFinder.path_hook((ExtensionFileLoader, EXTENSION_SUFFIXES),
                                    (_SourceOnlyLoader, SOURCE_SUFFIXES))


def _qualified_imports(path):
    location = Path(path).resolve()
    if not any(location.is_relative_to(root) for root in _qualified_roots):
        raise ImportError('Outside qualified source policy')
    return _source_finder(path)


# Filesystem Python is compiled from source in memory. Only the qualified
# interpreter's standard-library ZIP may supply precompiled Python bytecode.
sys.path_hooks.insert(0, _qualified_imports)
sys.path_importer_cache.clear()


def operator_python(config):
    configured = config.get('registryPython')
    if (not isinstance(configured, str) or not Path(configured).is_absolute()
            or Path(configured).resolve() != Path(sys.executable).resolve()):
        raise RuntimeError('Configuration must use the same operator interpreter')
    return sys.executable
