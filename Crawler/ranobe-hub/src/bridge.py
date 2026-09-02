"""Load both downloaders side by side and expose them as libraries.

Each project keeps its code in a package literally named `src`, so importing
both the normal way would have the second one shadow the first. They are loaded
here under distinct aliases instead — `annas_src` and `novelia_src` — which
keeps their own relative imports (`from .models import ...`) working.

Nothing is reimplemented on this side. Searching, ranking, volume detection,
downloading, converting and verifying all stay in the project that owns them,
so a fix there is a fix here too.
"""

import importlib
import sys
import types
from pathlib import Path
from typing import Optional

# Sibling projects, resolved relative to this one.
_ROOT = Path(__file__).resolve().parent.parent.parent
ANNAS_DIR = _ROOT / "annas-archive-downloader"
NOVELIA_DIR = _ROOT / "novelia-downloader"

ANNAS = "annas_src"
NOVELIA = "novelia_src"

_loaded = False


class BridgeError(RuntimeError):
    """A sibling project is missing or unusable."""


def _register(alias: str, project_dir: Path) -> None:
    package_dir = project_dir / "src"
    if not (package_dir / "__init__.py").exists():
        raise BridgeError(f"{project_dir.name} not found next to ranobe-hub "
                          f"(looked for {package_dir})")
    if alias in sys.modules:
        return
    package = types.ModuleType(alias)
    package.__path__ = [str(package_dir)]
    package.__package__ = alias
    sys.modules[alias] = package


def load() -> None:
    """Make both projects importable. Safe to call more than once."""
    global _loaded
    if _loaded:
        return
    _register(ANNAS, ANNAS_DIR)
    _register(NOVELIA, NOVELIA_DIR)
    _loaded = True


def annas(module: str):
    load()
    return importlib.import_module(f"{ANNAS}.{module}")


def novelia(module: str):
    load()
    return importlib.import_module(f"{NOVELIA}.{module}")


def versions() -> str:
    """A one-line note about what is wired up, for `status`."""
    load()
    return (f"annas   <- {ANNAS_DIR}\n"
            f"novelia <- {NOVELIA_DIR}")
