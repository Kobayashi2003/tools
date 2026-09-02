"""Declarative command registry: one parse / validate / bind / dispatch path.

A command declares its parameters once as `Param` specs; input parsing, type
coercion, defaults, help and completion all read from them -- a single source of
truth. Handlers stay plain functions ``handler(ctx, **params)`` and receive a
complete, already-typed keyword for every declared param.

Imported normally (not hot-reloaded), so `Param`/`Command` stay type-stable
across reloads of the commands module.
"""

from __future__ import annotations

import difflib
import inspect
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional, Tuple


class CommandError(Exception):
    """A user-input problem. Printed as a message, never as a traceback."""


class ExitShell(Exception):
    """Raised by the `exit` command to leave the prompt loop."""


# ==================== Parameter types ====================
# Each kind is (parse, value-hint, flaggable). `parse` returns the typed value
# or raises CommandError; `flaggable` allows a bare `:key` (no `=`) as shorthand.

def _parse_str(name: str, raw: str) -> str:
    return raw


def _parse_bool(name: str, raw: str) -> bool:
    low = raw.lower()
    if low in ('true', '1', 'yes', 'y', 'on'):
        return True
    if low in ('false', '0', 'no', 'n', 'off'):
        return False
    raise CommandError(f"'{name}' must be true or false, got '{raw}'.")


def _parse_int(name: str, raw: str) -> int:
    try:
        return int(raw)
    except ValueError:
        raise CommandError(f"'{name}' must be a number, got '{raw}'.")


def _parse_date(name: str, raw: str) -> str:
    try:
        datetime.fromisoformat(raw)
    except ValueError:
        raise CommandError(f"'{name}' must be a date (YYYY-MM-DD or ISO), got '{raw}'.")
    return raw


_TYPES: Dict[str, Tuple[Callable[[str, str], Any], str, bool]] = {
    'str':  (_parse_str,  '',           False),
    'bool': (_parse_bool, 'true|false', True),
    'int':  (_parse_int,  'N',          False),
    'date': (_parse_date, 'YYYY-MM-DD', False),
}


@dataclass(frozen=True)
class Param:
    name: str
    kind: str = 'str'
    default: Any = ''
    help: str = ''
    choices: Tuple[str, ...] = ()   # allowed values, if a fixed set
    hint: str = ''                  # value placeholder for a free-form param

    def __post_init__(self):
        if self.kind not in _TYPES:
            raise ValueError(f"param '{self.name}': unknown kind '{self.kind}'")

    @property
    def flaggable(self) -> bool:
        """True if a bare `:name` (no value) is allowed -- bools only."""
        return _TYPES[self.kind][2]

    def values(self) -> str:
        """Short hint of accepted values, for help and completion:
        the fixed choices, else an explicit placeholder, else the kind's own."""
        if self.choices:
            return '|'.join(self.choices)
        return self.hint or _TYPES[self.kind][1]

    def coerce(self, raw: Optional[str]) -> Any:
        """Text (or None for a bare flag) -> typed value; raises CommandError."""
        if raw is None:
            if self.flaggable:
                return True
            raise CommandError(f"'{self.name}' needs a value, e.g. {self.name}=...")
        value = _TYPES[self.kind][0](self.name, raw)
        if self.choices and value not in self.choices:
            raise CommandError(f"'{self.name}' must be one of {self.values()}, got '{raw}'.")
        return value


@dataclass(frozen=True)
class Command:
    name: str
    handler: Callable
    group: str
    summary: str
    params: Tuple[Param, ...] = ()
    aliases: Tuple[str, ...] = ()

    def signature(self) -> str:
        """`name:key=,key=` usage hint for help and error messages."""
        if not self.params:
            return self.name
        return f"{self.name}:" + ",".join(f"{p.name}=" for p in self.params)

    def bind(self, positional: str, pairs: Dict[str, Optional[str]]) -> Dict[str, Any]:
        """Merge parsed input onto the declared defaults; returns typed kwargs
        for every param, so handlers never need their own defaults."""
        if (positional or pairs) and not self.params:
            raise CommandError(f"'{self.name}' takes no parameters.")

        by_name = {p.name: p for p in self.params}
        values = {p.name: p.default for p in self.params}
        seen: set = set()

        if positional:
            first = self.params[0]
            values[first.name] = first.coerce(positional)
            seen.add(first.name)

        for key, raw in pairs.items():
            param = by_name.get(key)
            if param is None:
                raise CommandError(
                    f"Unknown parameter '{key}' for '{self.name}'. Usage: {self.signature()}")
            if key in seen:
                raise CommandError(f"Parameter '{key}' given twice.")
            values[key] = param.coerce(raw)
            seen.add(key)
        return values


def build_map(commands: List[Command]) -> Dict[str, Command]:
    """Name and alias -> Command. Registration order is preserved for help.

    Each handler's signature is checked against its declared params, so a rename
    that touches only one side fails loudly at load (and on every hot-reload),
    not at call time.
    """
    out: Dict[str, Command] = {}
    for cmd in commands:
        _check_signature(cmd)
        for key in (cmd.name, *cmd.aliases):
            if key in out:
                raise ValueError(f"duplicate command name: {key}")
            out[key] = cmd
    return out


def _check_signature(cmd: Command):
    args = [n for n in inspect.signature(cmd.handler).parameters if n != 'ctx']
    declared = [p.name for p in cmd.params]
    if args != declared:
        raise ValueError(
            f"{cmd.name}: handler args {args} != declared params {declared}")


# ==================== Input parsing ====================

def parse_input(text: str) -> Tuple[str, str, Dict[str, Optional[str]]]:
    """Split one input line into `(name, positional, pairs)`.

    Canonical form is ``command:key=value,key=value``; a bare remainder after a
    space (``help sync``) is returned as `positional` and bound to the command's
    first parameter. A bare ``key`` with no ``=`` maps to ``None`` -- a flag
    whose meaning depends on the param type (True for a bool).
    """
    text = text.strip()
    head, colon, rest = text.partition(':')
    if not colon:
        name, _, positional = text.partition(' ')
        return name.strip(), positional.strip(), {}

    pairs: Dict[str, Optional[str]] = {}
    for part in rest.split(','):
        part = part.strip()
        if not part:
            continue
        key, eq, value = part.partition('=')
        key = key.strip()
        if not key:
            raise CommandError(f"Bad parameter '{part}': use key=value.")
        pairs[key] = value.strip() if eq else None
    return head.strip(), '', pairs


def resolve(command_map: Dict[str, Command], name: str) -> Command:
    """Exact name or alias, else a unique prefix; anything else is an error
    with suggestions."""
    if name in command_map:
        return command_map[name]

    prefixed = {cmd.name: cmd for key, cmd in command_map.items()
                if key.startswith(name)}
    if len(prefixed) == 1:
        return next(iter(prefixed.values()))

    if prefixed:
        options = ', '.join(sorted(prefixed))
        raise CommandError(f"'{name}' is ambiguous: {options}")
    close = difflib.get_close_matches(name, command_map.keys(), n=3, cutoff=0.6)
    hint = f" Did you mean: {', '.join(close)}?" if close else " Type 'help'."
    raise CommandError(f"Unknown command '{name}'.{hint}")


# ==================== Completion ====================

def param_suggestions(cmd: Command, rest: str) -> List[Tuple[str, int, str]]:
    """Completions for the param fragment after ':'. `rest` is the text between
    the colon and the cursor. Returns `(insert, start_position, display)` tuples;
    `start_position` is negative, the length of text to replace.
    """
    if not cmd.params:
        return []
    segment = rest.split(',')[-1].lstrip()

    if '=' in segment:   # completing a value for key=
        key, _, partial = segment.partition('=')
        param = next((p for p in cmd.params if p.name == key.strip()), None)
        if param is None:
            return []
        options = param.choices or (('true', 'false') if param.flaggable else ())
        return [(o, -len(partial), o) for o in options if o.startswith(partial)]

    used = {kv.partition('=')[0].strip() for kv in rest.split(',')[:-1]}
    out = []
    for p in cmd.params:
        if p.name in used or not p.name.startswith(segment):
            continue
        display = f"{p.name}={p.values()}" if p.values() else p.name
        out.append((p.name, -len(segment), display))
    return out
