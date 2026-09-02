"""The console. A small REPL, because the interesting state is worth keeping.

Why a shell rather than one-shot flags: a search hits two catalogues and takes
seconds, the merged result is a structure worth looking at from more than one
angle, and the normal session is "find a series, look, adjust, fetch, next
series". Re-running a one-shot command would re-pay the search every time.

The interaction is built on one idea: **the policy decides, the table shows what
it decided, and you override only where you disagree.** Eleven volumes should
not be eleven questions.
"""

import shlex
import sys
from pathlib import Path
from typing import List, Optional

from . import bridge, fetch, merge, picker, view
from . import policy as policy_mod
from .catalog import ARCHIVE, SOURCE_ORDER, WEB, WENKU, Work

try:
    from prompt_toolkit import PromptSession
    from prompt_toolkit.completion import WordCompleter
    from prompt_toolkit.history import InMemoryHistory
    HAS_PTK = True
except Exception:                                   # pragma: no cover
    HAS_PTK = False

BANNER = """ranobe-hub — one console over annas-archive + novelia
type `help` for commands, `find <title>` to start"""

HELP = """
  Normal use is two commands — `find` puts you in the arrow-key screens, `get`
  downloads what you planned there.

    find <title>     search both catalogues, then pick a work and edit its plan
    get              download the current plan
    quit

  In the result list        In the plan grid
    up/down   move            up/down       volume
    enter     open            left/right    source for that volume
    q         back to prompt  space         include / exclude
                              a / n         include all / none
                              p             cycle the policy and re-plan
                              r             drop hand-made choices
                              b             back to the result list
                              enter         accept      q  cancel

  Settings
    policy [name]    show or switch the planning policy
    sources [both|annas|novelia]   limit which catalogues `find` queries
    out [dir]        show or set the output directory
    status           show wiring and settings

  Typing instead of arrows — these do the same work and are what you get when
  the terminal cannot host a full-screen screen (piped input, odd TERM):
    list             show the last search again
    open <n>         open work n
    take / drop <spec>   select volumes: 1,3,5-8 | all | none
    use <vol> <source>   pin one volume (annas / library / web)
    unpin <vol>      let the policy decide that volume again
    why <vol>        explain why the plan chose what it chose
"""


class Shell:
    def __init__(self, annas_config, novelia_config, output_dir: str = "downloads"):
        self.annas_config = annas_config
        self.novelia_config = novelia_config
        self.output_dir = Path(output_dir)
        self.works: List[Work] = []
        self.current: Optional[Work] = None
        self.policy = policy_mod.DEFAULT
        self.sources = "both"
        self.last_query = ""

    # ---- entry ----

    def run(self) -> int:
        print(BANNER)
        session = self._prompt_session()
        while True:
            try:
                line = (session.prompt("hub> ") if session else input("hub> ")).strip()
            except (EOFError, KeyboardInterrupt):
                print()
                return 0
            if not line:
                continue
            try:
                if not self.dispatch(line):
                    return 0
            except KeyboardInterrupt:
                print("\n  interrupted")
            except Exception as exc:                 # keep the session alive
                print(f"  error: {type(exc).__name__}: {exc}")

    def _prompt_session(self):
        """History and completion when the terminal supports it, plain input()
        otherwise — piping commands in is a normal way to script or test this."""
        if not HAS_PTK or not sys.stdin.isatty():
            return None
        words = ["find", "list", "open", "policy", "take", "drop", "use", "unpin",
                 "why", "get", "sources", "out", "status", "help", "quit"]
        try:
            return PromptSession(history=InMemoryHistory(),
                                 completer=WordCompleter(words, ignore_case=True))
        except Exception:
            # e.g. a console prompt_toolkit cannot drive (mismatched TERM on
            # Windows). The shell still works, just without the extras.
            return None

    def dispatch(self, line: str) -> bool:
        try:
            parts = shlex.split(line)
        except ValueError:
            parts = line.split()
        command, args = parts[0].lower(), parts[1:]
        rest = line[len(parts[0]):].strip()

        if command in ("quit", "exit", "q"):
            return False
        handler = {
            "help": lambda: print(HELP),
            "find": lambda: self.cmd_find(rest),
            "list": self.cmd_list,
            "open": lambda: self.cmd_open(args),
            "policy": lambda: self.cmd_policy(args),
            "take": lambda: self.cmd_select(args, True),
            "drop": lambda: self.cmd_select(args, False),
            "use": lambda: self.cmd_use(args),
            "unpin": lambda: self.cmd_unpin(args),
            "why": lambda: self.cmd_why(args),
            "get": self.cmd_get,
            "sources": lambda: self.cmd_sources(args),
            "out": lambda: self.cmd_out(args),
            "status": self.cmd_status,
        }.get(command)
        if handler is None:
            print(f"  unknown command {command!r} — try `help`")
            return True
        handler()
        return True

    # ---- commands ----

    def cmd_find(self, query: str) -> None:
        if not query:
            print("  usage: find <title>")
            return
        self.last_query = query
        print(f"  searching both catalogues for {query!r}…")
        works, notes = merge.search_all(
            self.annas_config, self.novelia_config, query,
            use_annas=self.sources in ("both", "annas"),
            use_novelia=self.sources in ("both", "novelia"))
        if notes:
            print(view.notes_block(notes))
        self.works = works
        self.current = None
        if not works:
            print("  nothing found")
            return
        for work in works:
            policy_mod.apply(work, self.policy)
        print(f"  {len(works)} work(s)")

        # Straight into the arrow-key list when the terminal allows it: picking
        # one of five results should not require reading indexes off a printout
        # and typing one back.
        if picker.usable():
            self.browse()
            return
        print()
        print(view.work_list(works))
        print("\n  `open <n>` for the per-volume view")

    def browse(self) -> None:
        """Work list -> plan -> work list, until something is accepted.

        The two screens are a loop rather than a one-way trip: opening the wrong
        work used to leave quitting to the prompt as the only way out.
        """
        start = 0
        while True:
            index = picker.choose_work(self.works, start=start)
            if index is None:
                print(f"  {len(self.works)} result(s) — `list` to see them again")
                return
            start = index
            self.current = self.works[index]
            print(f"  → {self.current.title}   [{self.current.summary()}]")
            outcome = self.open_current()
            if outcome != picker.BACK:
                return

    def cmd_list(self) -> None:
        if not self.works:
            print("  nothing searched yet")
            return
        print(view.work_list(self.works))

    def cmd_open(self, args: List[str]) -> None:
        if not self.works:
            print("  nothing searched yet")
            return
        if not args:
            print("  usage: open <n>")
            return
        try:
            index = int(args[0]) - 1
        except ValueError:
            print("  usage: open <n>")
            return
        if not 0 <= index < len(self.works):
            print(f"  no work {args[0]} — the list has {len(self.works)}")
            return
        self.current = self.works[index]
        self.open_current()

    def open_current(self) -> str:
        """Edit the plan with the arrow keys, or print it when that is not
        possible — the typed commands stay available either way."""
        policy_mod.apply(self.current, self.policy)
        if not picker.usable():
            self.show()
            return picker.ACCEPT
        outcome, chosen_policy = picker.edit_plan(self.current, self.policy)
        self.policy = chosen_policy
        if outcome == picker.BACK:
            return outcome
        if outcome == picker.CANCEL:
            print("  plan left as it was — `open` again to edit, `get` to download")
            return outcome
        stats = policy_mod.totals(self.current)
        by_source = " · ".join(f"{k} {v}" for k, v in stats["by_source"].items()) or "nothing"
        print(f"  plan: {stats['volumes']} volume(s) · {by_source} — `get` to download")
        return outcome

    def show(self) -> None:
        if self.current is None:
            print("  no work open — `open <n>` first")
            return
        print()
        print(view.coverage(self.current, self.policy))

    def cmd_policy(self, args: List[str]) -> None:
        if not args:
            print(f"  current: {self.policy} — {policy_mod.describe(self.policy)}")
            for name, text in policy_mod.POLICIES.items():
                mark = "*" if name == self.policy else " "
                print(f"   {mark} {name:<10} {text}")
            return
        name = args[0]
        if name not in policy_mod.POLICIES:
            print(f"  unknown policy {name!r}; known: {', '.join(policy_mod.POLICIES)}")
            return
        self.policy = name
        for work in self.works:
            policy_mod.apply(work, name)
        if self.current is not None:
            self.show()
        else:
            print(f"  policy: {name}")

    def cmd_select(self, args: List[str], value: bool) -> None:
        if self.current is None:
            print("  no work open — `open <n>` first")
            return
        spec = (" ".join(args) or "all").strip().lower()
        # `take none` means "select nothing", not "select every slot" — it is the
        # inverse of `take all`, so it flips the value rather than the range.
        if spec == "none":
            spec, value = "all", not value
        slots = self._slots_for(spec)
        if slots is None:
            return
        for slot in slots:
            slot.selected = value and bool(slot.offers)
        self.show()

    def cmd_use(self, args: List[str]) -> None:
        if self.current is None:
            print("  no work open — `open <n>` first")
            return
        if len(args) < 2:
            print(f"  usage: use <vol> <source>   ({' / '.join(SOURCE_ORDER)})")
            return
        target, source = args[0], args[1]
        source = {"library": WENKU, "wenku": WENKU, "文库": WENKU,
                  "web": WEB, "网络": WEB,
                  "annas": ARCHIVE, "archive": ARCHIVE}.get(source.lower(), source)
        slot = self._slot(target)
        if slot is None:
            return
        if source not in slot.offers:
            have = ", ".join(slot.offers) or "nothing"
            print(f"  volume {target}: {source} has no copy (available: {have})")
            return
        slot.chosen = source
        slot.pinned = True
        slot.selected = True
        self.show()

    def cmd_unpin(self, args: List[str]) -> None:
        if self.current is None or not args:
            print("  usage: unpin <vol>")
            return
        slot = self._slot(args[0])
        if slot is None:
            return
        slot.pinned = False
        policy_mod.apply(self.current, self.policy)
        self.show()

    def cmd_why(self, args: List[str]) -> None:
        if self.current is None or not args:
            print("  usage: why <vol>")
            return
        slot = self._slot(args[0])
        if slot is None:
            return
        print(f"  volume {slot.label}: {policy_mod.reason(self.current, slot, self.policy)}")
        for source in SOURCE_ORDER:
            offer = slot.offers.get(source)
            if offer:
                size = offer.size_text()
                print(f"    {source:<8} {offer.label} {size} {offer.language}".rstrip())

    def cmd_get(self) -> None:
        if self.current is None:
            print("  no work open — `open <n>` first")
            return
        planned = self.current.planned()
        if not planned:
            print("  nothing selected — `take all`")
            return
        stats = policy_mod.totals(self.current)
        by_source = " · ".join(f"{k} {v}" for k, v in stats["by_source"].items())
        folder = fetch.work_folder(self.output_dir, self.current)
        print(f"  {stats['volumes']} volume(s) [{by_source}] -> {folder}")
        ok, total = fetch.run_plan(self.current, self.annas_config,
                                   self.novelia_config, self.output_dir)
        print(f"\n  done: {ok}/{total} into {folder}")

    def cmd_sources(self, args: List[str]) -> None:
        if not args:
            print(f"  sources: {self.sources}")
            return
        choice = args[0].lower()
        if choice not in ("both", "annas", "novelia"):
            print("  usage: sources both|annas|novelia")
            return
        self.sources = choice
        print(f"  sources: {choice}")

    def cmd_out(self, args: List[str]) -> None:
        if args:
            self.output_dir = Path(" ".join(args))
        print(f"  output: {self.output_dir.resolve()}")

    def cmd_status(self) -> None:
        print(bridge.versions())
        print(f"  sources : {self.sources}")
        print(f"  policy  : {self.policy} — {policy_mod.describe(self.policy)}")
        print(f"  output  : {self.output_dir.resolve()}")
        print(f"  annas   : mirror={self.annas_config.mirror} "
              f"backend={self.annas_config.backend}")
        print(f"  novelia : site={self.novelia_config.site} mode={self.novelia_config.mode} "
              f"token={'yes' if self.novelia_config.token else 'no'}")
        if self.current is not None:
            print(f"  open    : {self.current.title}")

    # ---- helpers ----

    def _slot(self, label: str):
        for slot in self.current.slots:
            if slot.label == label:
                return slot
        print(f"  no volume {label!r} in this work")
        return None

    def _slots_for(self, spec: str):
        slots = self.current.slots
        spec = spec.strip().lower()
        if spec in ("all", "*", ""):
            return slots
        picked = []
        for part in spec.replace(" ", ",").split(","):
            if not part:
                continue
            if "-" in part and not part.startswith("-"):
                bounds = part.split("-")
                if len(bounds) != 2:
                    print(f"  cannot read {part!r}")
                    return None
                try:
                    low, high = float(bounds[0]), float(bounds[1])
                except ValueError:
                    print(f"  cannot read {part!r}")
                    return None
                for slot in slots:
                    try:
                        value = float(slot.label)
                    except ValueError:
                        continue
                    if min(low, high) <= value <= max(low, high):
                        picked.append(slot)
            else:
                match = next((s for s in slots if s.label == part), None)
                if match is None:
                    print(f"  no volume {part!r}")
                    return None
                picked.append(match)
        return picked
