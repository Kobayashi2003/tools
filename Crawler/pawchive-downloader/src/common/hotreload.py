"""Load a Python file by path and re-exec it when it changes on disk.

Used for hot-reloadable commands and format plugins. A missing plugin file is
tolerated: `dynamic_call` falls back to its `default`.
"""

from __future__ import annotations

import importlib.util
import pathlib
import types
from typing import Any

# Project root: this file is <root>/src/common/hotreload.py
_BASE_DIR = pathlib.Path(__file__).resolve().parents[2]

# Re-exec only when mtime changes: hot reload stays instant, while repeated
# calls (formatting thousands of paths) don't re-read from disk.
_MODULE_CACHE: dict[str, tuple[float, types.ModuleType]] = {}


def _load_module(module_filename: str) -> types.ModuleType:
    path = _BASE_DIR / module_filename
    if not path.exists():
        raise FileNotFoundError(f"Plugin file not found: {path}")

    mtime = path.stat().st_mtime
    cached = _MODULE_CACHE.get(str(path))
    if cached and cached[0] == mtime:
        return cached[1]

    # Name it after its path so its relative imports resolve.
    parts = pathlib.Path(module_filename).with_suffix('').parts
    full_name = '.'.join(parts)
    package = '.'.join(parts[:-1]) or None

    spec = importlib.util.spec_from_file_location(full_name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot create spec for {module_filename}")

    module = importlib.util.module_from_spec(spec)
    if package:
        module.__package__ = package
    spec.loader.exec_module(module)
    _MODULE_CACHE[str(path)] = (mtime, module)
    return module


def dynamic_get(var_name: str, module_filename: str, default=None) -> Any:
    """Read a module-level variable from a file, reloading it each call."""
    if not module_filename:
        raise ValueError("module_filename must be provided")
    module = _load_module(module_filename)
    value = getattr(module, var_name, None)
    if value is None:
        if default is None:
            raise AttributeError(f"Variable '{var_name}' not found in {module_filename}")
        return default
    return value


def dynamic_call(func_name: str, module_filename: str, *args: Any, default=None, **kwargs: Any) -> Any:
    """Call a function from a file, reloading it each call.

    With no args, returns the function itself so it can be used as a decorator.
    A missing file or function falls back to `default`.
    """
    if not module_filename:
        raise ValueError("module_filename must be provided")
    try:
        module = _load_module(module_filename)
        func = getattr(module, func_name, None)
    except FileNotFoundError:
        func = None
    if func is None:
        func = default
    if not callable(func):
        raise AttributeError(f"Function '{func_name}' not found or not callable in {module_filename}")
    if not args and not kwargs:
        return func  # decorator / late-binding use
    return func(*args, **kwargs)


def plugin_hook(func_name: str, module_filename: str):
    """Wrap `func` with a plugin decorator resolved on every call.

    Resolving per-call is what makes plugin edits hot-reload. With no plugin,
    `func` runs unchanged.
    """
    def decorator(func):
        def wrapper(*args, **kwargs):
            plugin = dynamic_call(func_name, module_filename, default=lambda inner: inner)
            return plugin(func)(*args, **kwargs)
        wrapper.__name__ = getattr(func, '__name__', func_name)
        return wrapper
    return decorator


__all__ = ["dynamic_get", "dynamic_call", "plugin_hook"]
