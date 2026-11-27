# Antigravity UsageOrb

UsageOrb is a Windows desktop widget for Antigravity. It shows context usage for the current conversation and the 5-hour and weekly quota when Antigravity reports those periods.

## Run

Open and sign in to Antigravity, then run `UsageOrb.exe`. Hover over the widget for a summary, or click it and select **Manage Usage** for details. You can also click the system tray icon or run `UsageOrb.exe --console`.

- **Quotas** shows remaining quota, reset countdowns, model groups, and the history captured while UsageOrb is running.
- **Context** shows context usage, compaction history, tools, and individual steps. Auto mode follows the desktop conversation. Choose a session manually if the title cannot be matched.
- **Usage** totals local transcript activity by time period, model, and tool. Reference costs are estimates.
- **Sessions** lists recorded conversations. Double-click a row or press Enter to open it in **Context**.
- **Settings** controls the widget, Windows integration, alerts, and local quota estimates.

## Build

Building from source requires the [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0). Run `.\build.ps1` from the project root. The script runs the tests and publishes a self-contained Windows x64 executable to `dist/UsageOrb.exe`. If UsageOrb was running during the build, restart it to load the new version.

## Startup and proxy

In **Settings**, enable **Follow Antigravity start and exit** and save to start the watcher at Windows sign-in. The widget and enabled tray icon appear when Antigravity opens. Telemetry pauses when it exits. Keep `UsageOrb.exe` in a fixed location when using the startup entry or Start menu shortcut.

**Launch Antigravity with proxy settings** applies the proxy on a fresh launch. It checks `USAGEORB_ANTIGRAVITY_PROXY`, `HTTPS_PROXY`, `HTTP_PROXY`, then the Windows proxy. `USAGEORB_ANTIGRAVITY_PROXY` defaults to unset and accepts an HTTP or HTTPS URL, or `none` for a direct launch. Set `USAGEORB_ANTIGRAVITY_EXE` for a custom installation path.

## Data sources

UsageOrb matches the desktop window title against local conversation metadata and calculates context usage from recorded model calls. After compaction it uses the checkpoint summary until the next measured call.

UsageOrb checks account quota about once a minute through the local service of the signed-in Antigravity desktop app. Check **Settings > Models** in Antigravity if a quota is unavailable. When a reading is missing or expired, UsageOrb shows a dash or uses an optional local token budget to estimate the remainder.

UsageOrb preferences are stored in `%LOCALAPPDATA%\AntigravityUsageOrb\settings.json`. Use `USAGEORB_DATA_DIR` to override the directory. **Settings > Desktop telemetry** shows the monitored transcript folders.
