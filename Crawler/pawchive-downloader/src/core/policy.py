"""What to do about each kind of failure, as a table instead of an if-ladder.

The right response to a status code is not a property of the code, it is a
property of the host serving it. One archive answers 403 while it warms a file
and wants patience; another means it and wants to be left alone. 404 is usually
permanent but can be a bad edge node. 429 always means "wait longer than you
were going to". None of that is knowable from here, so it is configuration.

A rule is looked up from the most specific key to the least:

    404  ->  4xx  ->  default          an HTTP status
    timeout -> network -> default      a connection that never answered
    invalid -> default                 a well-formed reply of the wrong shape

Written as a dict in config.json, or as one line in the environment:

    404=permanent,attempts=3; 429=retry,attempts=10,delay=60,backoff=1
"""

from dataclasses import dataclass
from typing import Dict, Optional

# `retry`     keep trying on the configured ladder.
# `fail`      give up now and report the error as it came. The file stays
#             undone, so the next run tries again from scratch.
# `permanent` give up and declare the resource gone. Unlike `fail`, this is
#             what stops an unbounded API retry from blocking every creator
#             behind one that was removed upstream.
ACTIONS = ('retry', 'fail', 'permanent')

# `retry` without an explicit count inherits the caller's bound (unlimited for
# API list requests, `download_max_retries` for files). The other two are
# decisions, not ladders, so absent a count they act the first time they match.
_DEFAULT_ATTEMPTS = {'retry': 0, 'fail': 1, 'permanent': 1}

_KINDS = ('network', 'timeout', 'connection', 'invalid', 'default')


class BadPolicy(ValueError):
    """A status-policy entry could not be read.

    Raised rather than dropped: a rule that silently failed to load would leave
    the host being treated by a policy the operator believes they replaced.
    """


@dataclass
class Rule:
    """One row of the table. `None` on a wait field means "use the global".

    `attempts` counts only failures that matched *this* row, so a 429 ladder is
    not advanced by unrelated 500s, and a 404 among other errors still has to
    be seen `attempts` times before it is believed. A negative value means
    never give up on this kind.
    """
    key: str = 'default'
    action: str = 'retry'
    attempts: int = 0
    delay: Optional[float] = None
    backoff: Optional[float] = None
    cap: Optional[float] = None
    jitter: Optional[float] = None

    def limit(self) -> int:
        """Attempts allowed for this row; 0 means "inherit the caller's bound"."""
        if self.attempts:
            return self.attempts
        return _DEFAULT_ATTEMPTS[self.action]

    def describe(self) -> str:
        return f"{self.key}/{self.action}"


_NUMERIC = {'attempts': int, 'delay': float, 'backoff': float,
            'cap': float, 'jitter': float}


def _normalize_key(key: str) -> str:
    key = str(key).strip().lower()
    if key in _KINDS:
        return key
    if len(key) == 3 and key[0] in '12345' and (key[1:].isdigit() or key[1:] == 'xx'):
        return key
    raise BadPolicy(
        f"unknown status key {key!r}: expected a status (404), a class (5xx), "
        f"or one of {', '.join(_KINDS)}")


def _rule_from(key: str, spec) -> Rule:
    """Build a Rule from `"retry,delay=60"` or `{"action": "retry", ...}`."""
    fields: Dict[str, str] = {}
    action = None

    if isinstance(spec, str):
        for part in spec.split(','):
            part = part.strip()
            if not part:
                continue
            if '=' in part:
                name, _, value = part.partition('=')
                fields[name.strip().lower()] = value.strip()
            elif action is None:
                action = part.lower()
            else:
                raise BadPolicy(f"{key}: unexpected {part!r}")
    elif isinstance(spec, dict):
        for name, value in spec.items():
            name = str(name).strip().lower()
            if name == 'action':
                action = str(value).strip().lower()
            else:
                fields[name] = value
    else:
        raise BadPolicy(f"{key}: expected a policy, got {spec!r}")

    action = action or fields.pop('action', None) or 'retry'
    if action not in ACTIONS:
        raise BadPolicy(f"{key}: unknown action {action!r}, expected one of "
                        f"{', '.join(ACTIONS)}")

    rule = Rule(key=key, action=action)
    for name, value in fields.items():
        cast = _NUMERIC.get(name)
        if cast is None:
            raise BadPolicy(f"{key}: unknown setting {name!r}, expected one of "
                            f"{', '.join(_NUMERIC)}")
        try:
            setattr(rule, name, cast(float(value)) if cast is int else cast(value))
        except (TypeError, ValueError):
            raise BadPolicy(f"{key}: {name}={value!r} is not a number") from None
    if rule.jitter is not None and not 0 <= rule.jitter <= 1:
        raise BadPolicy(f"{key}: jitter must be between 0 and 1")
    return rule


class StatusPolicies:
    """The lookup table. Immutable once built."""

    def __init__(self, rules: Dict[str, Rule] = None):
        self.rules: Dict[str, Rule] = dict(rules or {})
        self.rules.setdefault('default', Rule(key='default', action='retry'))

    # ==================== Building ====================

    @classmethod
    def parse(cls, value, fallback: Dict = None) -> 'StatusPolicies':
        """Read a table from a dict (config.json) or a string (environment).

        `fallback` supplies rows the operator did not write, so the built-in
        handling of a status stays in force until it is explicitly replaced.
        """
        rules: Dict[str, Rule] = {}
        for key, spec in (fallback or {}).items():
            rules[_normalize_key(key)] = _rule_from(_normalize_key(key), spec)
        for key, spec in cls._entries(value):
            key = _normalize_key(key)
            rules[key] = _rule_from(key, spec)
        return cls(rules)

    @staticmethod
    def _entries(value):
        """`{'404': {...}}` or `"404=permanent,attempts=3; 429=retry"` -> pairs."""
        if not value:
            return []
        if isinstance(value, dict):
            return list(value.items())
        if not isinstance(value, str):
            raise BadPolicy(f"expected a policy table, got {value!r}")
        entries = []
        for chunk in value.replace('\n', ';').split(';'):
            chunk = chunk.strip()
            if not chunk:
                continue
            if '=' not in chunk:
                raise BadPolicy(f"expected `status=action,...`, got {chunk!r}")
            key, _, spec = chunk.partition('=')
            entries.append((key.strip(), spec.strip()))
        return entries

    # ==================== Lookup ====================

    def match(self, status: Optional[int] = None, kind: str = 'network') -> Rule:
        """The rule for one failure: most specific key that exists, else default."""
        for key in self._chain(status, kind):
            rule = self.rules.get(key)
            if rule is not None:
                return rule
        return self.rules['default']

    @staticmethod
    def _chain(status: Optional[int], kind: str):
        if status:
            return (str(status), f"{status // 100}xx", 'default')
        if kind in ('timeout', 'connection'):
            return (kind, 'network', 'default')
        if kind == 'invalid':
            return ('invalid', 'default')
        return ('network', 'default')

    def describe(self) -> str:
        return '; '.join(
            f"{key}={rule.action}" + (f"/{rule.attempts}" if rule.attempts else "")
            for key, rule in sorted(self.rules.items()))
