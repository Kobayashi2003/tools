"""Interactive prompt: completion, persistent history, live status bar.

Degrades to plain `input()` when prompt_toolkit is missing or stdin is not a
tty; in that mode there is no status bar and no stdout patching, so output is
ordinary line-by-line text with no ANSI escapes.
"""

import sys
from contextlib import nullcontext
from typing import Callable, List, Optional

try:
    from prompt_toolkit.completion import Completer, Completion
    from prompt_toolkit.history import History
    from prompt_toolkit.patch_stdout import patch_stdout
    from prompt_toolkit.shortcuts import PromptSession as _PTSession
    HAS_PROMPT_TOOLKIT = True
except Exception:  # pragma: no cover - optional dependency
    HAS_PROMPT_TOOLKIT = False
    Completer = object  # type: ignore
    History = object    # type: ignore


def _is_interactive() -> bool:
    try:
        return sys.stdin.isatty() and sys.stdout.isatty()
    except Exception:
        return False


if HAS_PROMPT_TOOLKIT:

    class _JSONHistory(History):
        """Seed prompt history from the stored command history."""

        def __init__(self, storage):
            super().__init__()
            self.storage = storage

        def load_history_strings(self) -> List[str]:
            try:
                # Newest-first is what prompt_toolkit expects.
                return [r.command for r in self.storage.get_history(limit=1000)]
            except Exception:
                return []

        def store_string(self, string: str) -> None:
            # Persisted separately by the command loop; nothing to do here.
            pass

    class _CommandCompleter(Completer):
        """Complete command names before ':', then param names and values after
        it -- both from the same registry the parser and help read."""

        def __init__(self, get_commands: Callable[[], dict]):
            self.get_commands = get_commands

        def get_completions(self, document, complete_event):
            from .registry import CommandError, param_suggestions, resolve
            text = document.text_before_cursor
            if ':' in text:
                head, _, rest = text.partition(':')
                try:
                    cmd = resolve(self.get_commands(), head.strip())
                except CommandError:
                    return
                for insert, start, display in param_suggestions(cmd, rest):
                    yield Completion(insert, start_position=start, display=display)
                return
            if ' ' in text:  # a bare positional value; nothing to complete
                return
            low = text.lower()
            for key in sorted(self.get_commands().keys()):
                if not low or low in key:
                    yield Completion(key, start_position=-len(text), display=key)

    class _ArtistCompleter(Completer):
        """Match artists by index, id, name or alias."""

        def __init__(self, artists):
            # (search keys, display, value-to-insert)
            self.entries = []
            for i, a in enumerate(artists, 1):
                keys = [str(i), a.name.lower(), a.id.lower()]
                if a.alias:
                    keys.append(a.alias.lower())
                label = f"{i}. {a.display_name()} [{a.id}]"
                self.entries.append((keys, label, a.id))

        def get_completions(self, document, complete_event):
            text = document.text_before_cursor.lower()
            seen = set()
            for keys, label, value in self.entries:
                if (not text or any(text in k for k in keys)) and label not in seen:
                    seen.add(label)
                    yield Completion(value, start_position=-len(document.text_before_cursor),
                                     display=label)


class CLIPromptSession:
    """Main ``> `` prompt with history, completion and a bottom status bar.

    `status_line` (a callable returning one line of text) is rendered as the
    prompt_toolkit bottom toolbar and refreshed every second, so background
    download activity is visible without ever disturbing the input line.
    """

    def __init__(self, storage, get_commands: Callable[[], dict],
                 status_line: Optional[Callable[[], str]] = None):
        self.interactive = HAS_PROMPT_TOOLKIT and _is_interactive()
        if not self.interactive:
            self._session = None
        else:
            self._session = _PTSession(
                history=_JSONHistory(storage),
                completer=_CommandCompleter(get_commands),
                complete_while_typing=False,
                bottom_toolbar=status_line,
                refresh_interval=1.0 if status_line else 0.0,
            )

    def patched_stdout(self):
        """Context manager routing background prints above the input line."""
        if self.interactive:
            return patch_stdout(raw=True)
        return nullcontext()

    def prompt(self, message: str = "> ") -> str:
        if not self.interactive:
            return input(message).strip()
        try:
            return self._session.prompt(message).strip()
        except (EOFError, KeyboardInterrupt):
            raise
        except Exception:
            self.interactive = False  # terminal misbehaving; stay on plain input
            return input(message).strip()


def ask(message: str, default: str = "") -> Optional[str]:
    """One line of sub-prompt input; None means the user cancelled (Ctrl+C/EOF)."""
    try:
        return input(message).strip() or default
    except (EOFError, KeyboardInterrupt):
        print("\nCancelled.")
        return None


def confirm(question: str) -> bool:
    """Require an explicit `yes` before anything destructive."""
    answer = ask(f"{question} (yes/no): ")
    if answer is not None and answer.lower() == "yes":
        return True
    if answer is not None:
        print("Cancelled.")
    return False


def prompt_artist(message: str, artists) -> Optional[str]:
    """Prompt for an artist selection, with completion when available.

    Returns None when cancelled with Ctrl+C/EOF.
    """
    if not HAS_PROMPT_TOOLKIT or not _is_interactive():
        return ask(message)
    try:
        from prompt_toolkit import prompt as _prompt
        return _prompt(message, completer=_ArtistCompleter(artists)).strip()
    except (EOFError, KeyboardInterrupt):
        print("\nCancelled.")
        return None
    except Exception:
        return ask(message)
