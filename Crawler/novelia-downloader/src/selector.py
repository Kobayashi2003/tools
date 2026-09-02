"""Interactive checkbox list over the per-volume picks.

Uses prompt_toolkit for a real arrow-keys-and-space checkbox when there is a
tty and the package is installed; otherwise falls back to a numbered list plus
a selection expression, which also covers piped/CI use.
"""

import sys
from typing import List, Optional, Sequence

try:
    from prompt_toolkit.application import Application
    from prompt_toolkit.formatted_text import to_formatted_text
    from prompt_toolkit.key_binding import KeyBindings
    from prompt_toolkit.layout import Layout, Window
    from prompt_toolkit.layout.controls import FormattedTextControl
    from prompt_toolkit.layout.dimension import Dimension
    from prompt_toolkit.data_structures import Point
    from prompt_toolkit.styles import Style
    HAS_PROMPT_TOOLKIT = True
except Exception:  # pragma: no cover - optional dependency
    HAS_PROMPT_TOOLKIT = False


_HELP = "↑/↓ move · space toggle · a all · n none · i invert · enter download · q cancel"

_STYLE = {
    "header": "bold",
    "help": "#888888",
    "cursor": "bold #00afff",
    "mark": "bold #00d75f",
    "dim": "#888888",
    "alt": "#af87ff",
}


def choose(rows: Sequence[str], preselected: Optional[Sequence[bool]] = None,
           header: str = "") -> Optional[List[int]]:
    """Return the indexes the user checked, or None if they cancelled."""
    if not rows:
        return []
    selected = list(preselected) if preselected is not None else [True] * len(rows)
    if HAS_PROMPT_TOOLKIT and _is_tty():
        return _checkbox_app(rows, selected, header)
    return _text_prompt(rows, selected, header)


def _is_tty() -> bool:
    try:
        return sys.stdin.isatty() and sys.stdout.isatty()
    except Exception:
        return False


def _checkbox_app(rows, selected, header) -> Optional[List[int]]:
    state = {"cursor": 0, "cancelled": False}

    def render():
        fragments = []
        if header:
            fragments.append(("class:header", header + "\n"))
        fragments.append(("class:help", _HELP + "\n\n"))
        for index, row in enumerate(rows):
            at_cursor = index == state["cursor"]
            fragments.append(("class:cursor" if at_cursor else "", "❯ " if at_cursor else "  "))
            fragments.append(("class:mark" if selected[index] else "class:dim",
                              "[x] " if selected[index] else "[ ] "))
            fragments.append(("" if selected[index] else "class:dim", row))
            fragments.append(("", "\n"))
        fragments.append(("class:help",
                          f"\n{sum(selected)} of {len(rows)} selected"))
        return to_formatted_text(fragments)

    # render() emits: [header] then the help line then a blank line, so the first
    # row sits that many lines down. Reporting the wrong line makes the viewport
    # scroll one row short and clip the last entry.
    first_row_line = (1 if header else 0) + 2

    def cursor_position():
        # Keeps the highlighted row inside the viewport as the list scrolls.
        return Point(x=0, y=state["cursor"] + first_row_line)

    control = FormattedTextControl(render, focusable=True,
                                   get_cursor_position=cursor_position)
    window = Window(control, height=Dimension(preferred=len(rows) + 4), wrap_lines=False)

    keys = KeyBindings()

    @keys.add("up")
    @keys.add("k")
    def _(event):
        state["cursor"] = max(0, state["cursor"] - 1)

    @keys.add("down")
    @keys.add("j")
    def _(event):
        state["cursor"] = min(len(rows) - 1, state["cursor"] + 1)

    @keys.add("home")
    @keys.add("g")
    def _(event):
        state["cursor"] = 0

    @keys.add("end")
    @keys.add("G")
    def _(event):
        state["cursor"] = len(rows) - 1

    @keys.add("pageup")
    def _(event):
        state["cursor"] = max(0, state["cursor"] - 10)

    @keys.add("pagedown")
    def _(event):
        state["cursor"] = min(len(rows) - 1, state["cursor"] + 10)

    @keys.add("space")
    def _(event):
        selected[state["cursor"]] = not selected[state["cursor"]]

    @keys.add("a")
    def _(event):
        selected[:] = [True] * len(rows)

    @keys.add("n")
    def _(event):
        selected[:] = [False] * len(rows)

    @keys.add("i")
    def _(event):
        selected[:] = [not value for value in selected]

    @keys.add("enter")
    def _(event):
        event.app.exit()

    @keys.add("q")
    @keys.add("escape")
    @keys.add("c-c")
    def _(event):
        state["cancelled"] = True
        event.app.exit()

    Application(layout=Layout(window), key_bindings=keys,
                style=Style.from_dict(_STYLE), full_screen=False,
                mouse_support=False, erase_when_done=False).run()

    if state["cancelled"]:
        return None
    return [index for index, value in enumerate(selected) if value]


def _text_prompt(rows, selected, header) -> Optional[List[int]]:
    if header:
        print(header)
    for index, row in enumerate(rows, 1):
        print(f"  {'[x]' if selected[index - 1] else '[ ]'} {index:>3}. {row}")
    print("\nSelect: numbers/ranges (1,3,5-8), `all`, `none`, `-4` to drop one,")
    print("        blank = keep the current selection, `q` = cancel.")
    while True:
        try:
            answer = input("> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return None
        if answer.lower() in ("q", "quit", "cancel"):
            return None
        if not answer:
            return [i for i, value in enumerate(selected) if value]
        if _apply_expression(answer, selected):
            return [i for i, value in enumerate(selected) if value]
        print("Could not read that selection, try again.")


def _apply_expression(answer: str, selected: List[bool]) -> bool:
    lowered = answer.lower()
    if lowered in ("all", "a", "*"):
        selected[:] = [True] * len(selected)
        return True
    if lowered in ("none", "n"):
        selected[:] = [False] * len(selected)
        return True

    # Leading "-" edits the current selection by removing entries; anything else
    # replaces the selection with exactly what was listed.
    removing = answer.lstrip().startswith("-")
    pending = list(selected) if removing else [False] * len(selected)

    ok = False
    for part in answer.replace(" ", ",").split(","):
        part = part.strip()
        if not part:
            continue
        drop = part.startswith("-")
        bounds = part[1:].split("-") if drop else part.split("-")
        try:
            if len(bounds) == 1:
                start = end = int(bounds[0])
            elif len(bounds) == 2:
                start, end = int(bounds[0]), int(bounds[1])
            else:
                return False
        except ValueError:
            return False
        for number in range(min(start, end), max(start, end) + 1):
            if 1 <= number <= len(pending):
                pending[number - 1] = not drop
                ok = True
    if ok:
        selected[:] = pending
    return ok
