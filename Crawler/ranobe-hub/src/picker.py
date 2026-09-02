"""Arrow-key screens: choose a work, then edit the plan in place.

Typing `use 3 annas` and `take 1-5,7` works, but it makes you hold the table in
your head and address rows by name. The plan is a grid — volumes down, sources
across — so the natural way to edit it is to move around that grid:

    up / down     the volume
    left / right  the source for that volume
    space         include or exclude the volume
    a / n         include all / none
    p             cycle the policy and re-plan
    r             drop every hand-made choice
    b             back to the result list
    enter         accept                        q  cancel

`left`/`right` sets the source rather than merely highlighting it, so a choice
is one keystroke and the effect is visible immediately in the plan column.

`usable()` reports whether these screens can run at all; when they cannot, the
shell falls back to its typed commands and prints the same tables instead.
"""

import sys
from typing import List, Optional, Tuple

from .catalog import SOURCE_ORDER, Slot, Work
from . import policy as policy_mod
from . import view

try:
    from prompt_toolkit.application import Application
    from prompt_toolkit.data_structures import Point
    from prompt_toolkit.formatted_text import to_formatted_text
    from prompt_toolkit.key_binding import KeyBindings
    from prompt_toolkit.layout import Layout, ScrollOffsets, Window
    from prompt_toolkit.layout.controls import FormattedTextControl
    from prompt_toolkit.layout.dimension import Dimension
    from prompt_toolkit.styles import Style
    HAS_PTK = True
except Exception:                                    # pragma: no cover
    HAS_PTK = False

_STYLE = {
    "head": "bold",
    "hint": "#888888",
    "cursor": "bold #00afff",
    "on": "bold #00d75f",
    "off": "#666666",
    # The chosen cell is marked by weight and colour, not by `reverse`. Reversing
    # it painted a solid block down any column that won every row, which reads as
    # a rendering fault rather than as information — and the plan column already
    # names the winner.
    "pick": "bold #00d75f",
    "warn": "#ff8700",
}


def usable() -> bool:
    """Whether an interactive screen can run here."""
    if not HAS_PTK:
        return False
    try:
        return sys.stdin.isatty() and sys.stdout.isatty()
    except Exception:
        return False


#: Tall lists get a scrolling viewport rather than a screen-height one.
MAX_ROWS = 24


def _run(control_text, keys, height, cursor_line) -> None:
    """`cursor_line` must return the line the selection is on.

    Reporting a fixed line instead makes the viewport stay at the top: the
    selection then walks off the bottom of a long list and becomes invisible,
    which is exactly what happens on a search like 落第騎士の英雄譚.

    The render is erased on exit and the caller prints a one-line summary in its
    place. Leaving it behind stacked a finished list above the live one, cursor
    and all, with nothing to say which of the two was still taking keys.
    """
    control = FormattedTextControl(control_text, focusable=True,
                                   get_cursor_position=lambda: Point(0, cursor_line()))
    window = Window(control, height=Dimension(preferred=min(height, MAX_ROWS)),
                    wrap_lines=False, scroll_offsets=ScrollOffsets(top=1, bottom=1))
    Application(layout=Layout(window), key_bindings=keys,
                style=Style.from_dict(_STYLE), full_screen=False,
                mouse_support=False, erase_when_done=True).run()


# ---- choosing a work ----

def choose_work(works: List[Work], start: int = 0) -> Optional[int]:
    """Single-select over the search results. Returns an index, or None.

    `start` puts the cursor back where it was, so stepping back from a plan
    lands on the work you had just been looking at.
    """
    if not works:
        return None
    state = {"row": min(max(0, start), len(works) - 1), "cancelled": False}
    blocks = [_work_block(w) for w in works]

    def render():
        out = [("class:hint", "  up/down move · enter open · q cancel\n\n")]
        for index, block in enumerate(blocks):
            at = index == state["row"]
            out.append(("class:cursor" if at else "", "❯ " if at else "  "))
            out.append(("class:head" if at else "", block[0] + "\n"))
            for line in block[1:]:
                out.append(("", f"    {line}\n"))
            out.append(("", "\n"))
        return to_formatted_text(out)

    keys = KeyBindings()

    @keys.add("up")
    @keys.add("k")
    def _(event):
        state["row"] = max(0, state["row"] - 1)

    @keys.add("down")
    @keys.add("j")
    def _(event):
        state["row"] = min(len(works) - 1, state["row"] + 1)

    @keys.add("enter")
    def _(event):
        event.app.exit()

    @keys.add("q")
    @keys.add("escape")
    @keys.add("c-c")
    def _(event):
        state["cancelled"] = True
        event.app.exit()

    def cursor_line() -> int:
        # 2 header lines, then each earlier block plus its trailing blank.
        return 2 + sum(len(b) + 1 for b in blocks[:state["row"]])

    height = sum(len(b) + 1 for b in blocks) + 3
    _run(render, keys, height, cursor_line)
    return None if state["cancelled"] else state["row"]


def _work_block(work: Work) -> List[str]:
    lines = [work.title]
    if work.title_alt:
        lines.append(work.title_alt)
    if work.authors:
        lines.append(f"author  : {', '.join(work.authors)}")
    lines.append(f"sources : {work.summary()}")
    numbered = work.numbered()
    if numbered:
        lines.append(f"volumes : {len(numbered)}  ({view._volume_span(numbered)})")
    elif work.slots:
        lines.append(f"volumes : {len(work.slots)} (no volume numbers found)")
    return lines


# ---- editing the plan ----

#: What `edit_plan` was left with.
ACCEPT, BACK, CANCEL = "accept", "back", "cancel"


def edit_plan(work: Work, policy_name: str) -> Tuple[str, str]:
    """Walk the coverage grid. Returns (outcome, policy_name).

    `outcome` is ACCEPT, BACK (return to the work list and pick another) or
    CANCEL. Without BACK the only way out of a wrong pick was to quit to the
    prompt and search again.

    The policy can change from in here, so it is handed back rather than kept.
    """
    slots = work.slots
    if not slots:
        return CANCEL, policy_name
    state = {"row": 0, "outcome": ACCEPT, "policy": policy_name}
    columns = [s for s in SOURCE_ORDER
               if any(s in slot.offers for slot in slots)] or list(SOURCE_ORDER)
    widths = {c: max(18, view._width(c) + 2) for c in columns}

    def move_source(step: int) -> None:
        slot = slots[state["row"]]
        available = [c for c in columns if c in slot.offers]
        if not available:
            return
        if slot.chosen in available:
            index = (available.index(slot.chosen) + step) % len(available)
        else:
            index = 0
        slot.chosen = available[index]
        # Choosing by hand means the policy must stop overruling it.
        slot.pinned = True
        slot.selected = True

    def render():
        out = [("class:head", f"  {work.title}\n")]
        meta = " · ".join(x for x in [", ".join(work.authors), work.publisher] if x)
        if meta:
            out.append(("class:hint", f"  {meta}\n"))
        out.append(("class:hint",
                    f"  policy: {state['policy']} "
                    f"({policy_mod.short(state['policy'])})\n"))
        # Two short lines rather than one long one: this screen has to stay
        # readable in a narrow console.
        if len(columns) > 1:
            out.append(("class:hint",
                        "  up/down volume · left/right source · space include\n"))
        else:
            # Saying "left/right source" here would send you hunting for a
            # second column that does not exist.
            out.append(("class:hint",
                        f"  up/down volume · space include · "
                        f"only one source ({columns[0]}), nothing to switch to\n"))
        out.append(("class:hint",
                    "  a all · n none · p policy · r reset · "
                    "b back to list · enter accept · q cancel\n\n"))

        header = "      vol  " + " ".join(view._pad(c, widths[c]) for c in columns)
        out.append(("class:hint", header + " plan\n"))

        for index, slot in enumerate(slots):
            at_row = index == state["row"]
            out.append(("class:cursor" if at_row else "", " ❯ " if at_row else "   "))
            mark = "x" if slot.selected and slot.chosen else " "
            out.append(("class:on" if mark == "x" else "class:off", f"[{mark}] "))
            out.append(("", f"{slot.label:>3}  "))
            # Emphasis only means something where there was a choice to make.
            contested = len(slot.offers) > 1
            for column in columns:
                offer = slot.offers.get(column)
                text = view._pad(view._cell_text(offer), widths[column])
                if offer is None:
                    out.append(("class:off", text + " "))
                elif contested and slot.chosen == column:
                    out.append(("class:pick", text + " "))
                else:
                    out.append(("", text + " "))
            plan = slot.chosen or "—"
            if slot.pinned:
                plan += "*"
            out.append(("class:hint" if not slot.selected else "", plan + "\n"))

        out.append(("", "\n"))
        for line in _footer(work, state["policy"]):
            out.append(("class:warn" if line.startswith("untranslated") else "class:hint",
                        "  " + line + "\n"))
        return to_formatted_text(out)

    keys = KeyBindings()

    @keys.add("up")
    def _(event):
        state["row"] = max(0, state["row"] - 1)

    @keys.add("down")
    def _(event):
        state["row"] = min(len(slots) - 1, state["row"] + 1)

    @keys.add("left")
    def _(event):
        move_source(-1)

    @keys.add("right")
    def _(event):
        move_source(1)

    @keys.add("space")
    def _(event):
        slot = slots[state["row"]]
        if slot.offers:
            slot.selected = not slot.selected

    @keys.add("a")
    def _(event):
        for slot in slots:
            slot.selected = bool(slot.offers)

    @keys.add("n")
    def _(event):
        for slot in slots:
            slot.selected = False

    @keys.add("p")
    def _(event):
        names = list(policy_mod.POLICIES)
        state["policy"] = names[(names.index(state["policy"]) + 1) % len(names)]
        policy_mod.apply(work, state["policy"])

    @keys.add("r")
    def _(event):
        # Drop every hand-made choice and let the policy decide again.
        for slot in slots:
            slot.pinned = False
        policy_mod.apply(work, state["policy"])
        for slot in slots:
            slot.selected = bool(slot.offers)

    @keys.add("home")
    def _(event):
        state["row"] = 0

    @keys.add("end")
    def _(event):
        state["row"] = len(slots) - 1

    @keys.add("pageup")
    def _(event):
        state["row"] = max(0, state["row"] - 10)

    @keys.add("pagedown")
    def _(event):
        state["row"] = min(len(slots) - 1, state["row"] + 10)

    @keys.add("enter")
    def _(event):
        event.app.exit()

    @keys.add("b")
    @keys.add("backspace")
    def _(event):
        state["outcome"] = BACK
        event.app.exit()

    @keys.add("q")
    @keys.add("escape")
    @keys.add("c-c")
    def _(event):
        state["outcome"] = CANCEL
        event.app.exit()

    def cursor_line() -> int:
        meta = " · ".join(x for x in [", ".join(work.authors), work.publisher] if x)
        header = 1 + (1 if meta else 0) + 1 + 1 + 1 + 1 + 1
        return header + state["row"]

    _run(render, keys, len(slots) + 12, cursor_line)
    return state["outcome"], state["policy"]


def _footer(work: Work, policy_name: str) -> List[str]:
    stats = policy_mod.totals(work)
    by_source = " · ".join(f"{k} {v}" for k, v in stats["by_source"].items()) or "nothing"
    size, unsized = stats["bytes"], stats["unsized"]
    if size and unsized:
        size_text = f"≥{size / 1024 / 1024:.0f} MB (+{unsized} of unknown size)"
    elif size:
        size_text = f"~{size / 1024 / 1024:.0f} MB"
    elif unsized:
        size_text = "size not published"
    else:
        size_text = "nothing to fetch"
    count = f"{stats['volumes']} volume(s)"
    if stats["extras"]:
        count += f" + {stats['extras']} unnumbered"
    lines = [f"plan: {count} · {by_source} · "
             f"gaps: {', '.join(stats['gaps']) or 'none'} · {size_text}"]
    untranslated = [s.label for s in work.planned()
                    if s.offer() is not None and not s.offer().translatable]
    if untranslated:
        lines.append(f"untranslated (nothing to convert from): {', '.join(untranslated)}")
    return lines
