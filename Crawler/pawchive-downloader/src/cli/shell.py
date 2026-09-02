"""The interactive shell: prompt loop, dispatch, and error/Ctrl+C policy.

Policy: a user-input problem prints a one-line message; an unexpected failure
prints `Error: ...` and logs the traceback -- the user never sees a stack
trace. Ctrl+C inside a command abandons that command and returns to the
prompt (state files are written atomically, so there is nothing to corrupt);
Ctrl+C at the prompt itself requests shutdown.
"""

import traceback

from ..common.jsonio import CorruptJSON
from ..common.naming import human_size
from .prompt import CLIPromptSession
from .registry import CommandError, ExitShell, parse_input, resolve


def run(ctx, get_commands, logger):
    session = CLIPromptSession(ctx.storage, get_commands, status_line=_status_line(ctx))
    with session.patched_stdout():
        while True:
            try:
                text = session.prompt("> ")
            except EOFError:
                return
            except KeyboardInterrupt:
                print()
                return
            if text:
                try:
                    _dispatch(ctx, get_commands(), text, logger)
                except ExitShell:
                    return


def _dispatch(ctx, command_map, text, logger):
    try:
        name, positional, pairs = parse_input(text)
        cmd = resolve(command_map, name)
        if cmd.name != name and name not in cmd.aliases:
            print(f"-> {cmd.name}")
        kwargs = cmd.bind(positional, pairs)
    except CommandError as e:
        print(e)
        return

    try:
        cmd.handler(ctx, **kwargs)
        ctx.storage.add_history(cmd.name, success=True, artist_id=ctx._last_artist,
                                params=kwargs)
    except ExitShell:
        raise
    except KeyboardInterrupt:
        print("\nCommand interrupted. Background downloads continue; "
              "'cancel-all' stops them, 'exit' quits.")
    except CommandError as e:
        ctx.storage.add_history(cmd.name, success=False, artist_id=ctx._last_artist,
                                params=kwargs, note=str(e))
        print(e)
    except CorruptJSON as e:
        ctx.storage.add_history(cmd.name, success=False, artist_id=ctx._last_artist,
                                params=kwargs, note=str(e))
        print(f"Cache problem: {e}\n"
              f"Nothing was overwritten. Restore that file from a backup, or delete "
              f"it to re-fetch the creator from scratch.")
    except Exception as e:
        ctx.storage.add_history(cmd.name, success=False, artist_id=ctx._last_artist,
                                params=kwargs, note=str(e))
        logger.cli_command_failed(command=cmd.name, error=str(e),
                                  trace=traceback.format_exc(), level='error')
        print(f"Error: {e}  (details in the log)")
    finally:
        ctx._last_artist = None


def _status_line(ctx):
    """Builds the bottom-toolbar callable: queue state plus, when the `notify`
    switch is on, live file counts and throughput from the notifier.

    Display names are memoized: the toolbar refreshes every second and must not
    re-read the whole artists tree each time."""
    names_seen = {}

    def _display(artist_id: str) -> str:
        if artist_id not in names_seen:
            artist = ctx.storage.get_artist(artist_id)
            names_seen[artist_id] = artist.display_name() if artist else artist_id
        return names_seen[artist_id]

    def line():
        st = ctx.scheduler.status()
        parts = []
        if st['running']:
            names = [t.artist_id for t in ctx.scheduler.list_active()]
            shown = ', '.join(_display(n) for n in names[:3])
            if len(names) > 3:
                shown += f" +{len(names) - 3}"
            parts.append(f"downloading {shown}")
        if st['queued']:
            parts.append(f"{st['queued']} queued")
        snap = ctx.downloader.notifier.snapshot()
        if snap['files']:
            parts.append(f"{len(snap['files'])} file(s) at {human_size(int(snap['speed']))}/s")
        if st['completed']:
            done = ctx.scheduler.completed
            failed = sum(1 for t in done if t.error)
            parts.append(f"{len(done)} finished" + (f", {failed} failed" if failed else ""))
        return " | ".join(parts) if parts else "idle - 'help' for commands"
    return line
