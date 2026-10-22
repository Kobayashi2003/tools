"""Open files and folders on this computer, from the server process."""

import os
import subprocess
import sys
import time
from pathlib import Path


def open_path(path: Path) -> None:
    """Open a file with its default application, or a folder in the file manager. On Windows a
    folder already open in Explorer is reused, and the window is brought in front of the
    browser."""
    if sys.platform != "win32":
        subprocess.Popen(["open" if sys.platform == "darwin" else "xdg-open", str(path)])
        return
    if not path.is_dir():
        os.startfile(path)
        return
    if window := explorer_window(path):
        focus(window)
        return
    os.startfile(path)
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        time.sleep(0.1)
        if window := explorer_window(path):
            focus(window)
            return


if sys.platform == "win32":
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    EnumWindowsProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def explorer_window(folder: Path) -> int | None:
        """An Explorer window showing `folder`. Its title is the folder's name, or its full path
        when Explorer is set to show that, then " - " and "File Explorer" in the system's
        language. A window with tabs shows only its current tab."""
        titles = {folder.name.casefold(), str(folder).casefold()}
        found: list[int] = []

        def check(hwnd: int, _: int) -> bool:
            name = ctypes.create_unicode_buffer(64)
            user32.GetClassNameW(hwnd, name, 64)
            if name.value == "CabinetWClass":
                title = ctypes.create_unicode_buffer(1024)
                user32.GetWindowTextW(hwnd, title, 1024)
                if title.value.rsplit(" - ", 1)[0].casefold() in titles:
                    found.append(hwnd)
                    return False
            return True

        user32.EnumWindows(EnumWindowsProc(check), 0)
        return found[0] if found else None

    def focus(hwnd: int) -> None:
        """Bring a window to the front. Windows lets only the foreground thread do that, so the
        server borrows its input state for the call."""
        foreground = user32.GetWindowThreadProcessId(user32.GetForegroundWindow(), None)
        own = ctypes.windll.kernel32.GetCurrentThreadId()
        attached = foreground != own and user32.AttachThreadInput(own, foreground, True)
        try:
            if user32.IsIconic(hwnd):
                user32.ShowWindow(hwnd, 9)  # SW_RESTORE
            user32.BringWindowToTop(hwnd)
            user32.SetForegroundWindow(hwnd)
        finally:
            if attached:
                user32.AttachThreadInput(own, foreground, False)

else:

    def explorer_window(folder: Path) -> int | None:
        return None

    def focus(hwnd: int) -> None:
        pass
