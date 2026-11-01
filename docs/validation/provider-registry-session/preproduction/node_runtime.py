"""Approved Windows x64 Node runtime. Never resolve an executable through PATH."""
import hashlib
from pathlib import Path

NODE_VERSION = '22.23.4'
# Official node-v22.23.4-win-x64.zip, independently verified at artifact freeze.
NODE_SHA256 = 'dccc52de28d8df2ee22d2062424f8c563070d95d8ad70c54c4bf01d590dec14f'


def pinned_node(value):
    if not isinstance(value, str):
        raise RuntimeError('An absolute pinned Node executable is required')
    path = Path(value)
    if not path.is_absolute() or path.name.lower() != 'node.exe' or not path.is_file():
        raise RuntimeError('An absolute pinned Node executable is required')
    if any(':' in part for part in path.parts[1:]):
        raise RuntimeError('Node stream paths are forbidden')
    if any(part.is_symlink() or part.stat().st_file_attributes & 0x400 for part in (path, *path.parents)):
        raise RuntimeError('Node reparse paths are forbidden')
    if path.stat().st_nlink != 1 or hashlib.sha256(path.read_bytes()).hexdigest() != NODE_SHA256:
        raise RuntimeError('Node '+NODE_VERSION+' Windows x64 identity required before business imports')
    return str(path)
