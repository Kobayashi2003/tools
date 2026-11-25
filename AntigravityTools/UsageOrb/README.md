# Antigravity UsageOrb

A lightweight native Windows (.NET 8 / WPF) desktop companion styled in **Obsidian Glass** that displays real-time **Google Antigravity** **Context Window %**, **5-Hour Quota Remaining %**, and **Weekly Quota Remaining %** through a progressive **Floating Widget (Circular Orb or 3-Metric Pill) → Hover Mini-Card → Click Popover → Full Management Console** experience.

Zero host patching. Zero LLM tokens consumed. 100% read-only over official local Antigravity telemetry.

---

## Progressive Disclosure UI (v2.0 Obsidian Glass)

1. **Floating Widget (Two Toggleable Shapes)**
   - **Circular Dual-Ring Orb** *(default, `32 / 40 / 48 px`)*: Outer arc shows **Active Context Window %**, inner arc shows **5-Hour Quota Remaining %**, center displays crisp tabular `%`, and a top-right emerald dot pulses during active turns.
   - **Compact 3-Metric Pill** *(toggleable via right-click menu, tray menu, or Settings)*: Single-row glass capsule displaying `CTX · 5H · WK` percentages simultaneously with color-coded health dots.
   - **Follow Antigravity Window** *(default)*: Tracks the Antigravity App / IDE window automatically via Win32 `SetWinEventHook` (anchorable to `TL`, `TR`, `BL`, or `BR`, or dragged freely) and hides when Antigravity is minimized or occluded.
   - **Free Float Mode**: Optionally pins anywhere on screen with adjustable idle opacity.
   - Non-activating (`WS_EX_NOACTIVATE`) so hovering or dragging never steals focus from your chat composer.

2. **Hover Mini-Card (~200ms hover)**
   - Compact matte glass card displaying active model, `● LIVE` / surface badge, and **Big-3 horizontal progress bars**: **Context Window %**, **5-Hour Remaining %** (`Live` or `Est.`), and **Weekly Remaining %** (`Live` or `Est.`), plus Cache Hit %.

3. **Click Popover (Single left-click)**
   - Interactive floating card with vector dual-ring header, session switcher (`Auto · Active Conversation` or recent chats), **Big-3 Hero Stack** (multi-segment stacked context bar + 5h & Weekly progress bars with live 1-second ticking reset countdowns), 3-stat strip (`Cache Hit`, `Last Δ`, `Compactions`), ghost `Copy`, and high-contrast **`Manage Usage ↗`**.

4. **Full Management Console (`Manage Usage ↗` or tray left-click)**
   - Custom dark/light window chrome (`WindowChrome` + DWM rounded corners), vector concentric-ring icon, slim `6px` pill scrollbars, and unified segmented pill navigation:
     - **Overview & Quotas**: 3-Pillar Hero Stage (`ACTIVE CONTEXT`, `5-HOUR QUOTA REMAINING`, `WEEKLY QUOTA REMAINING` with adaptive surface tints), slim secondary metric strip (Cache Efficiency, Sprint Pace, Est. Ref Spend), `5h Sprint vs 7d Weekly` quota-group matrix, interactive stacked burn-rate timeline (`5H / 24H / 7D / 30D / ALL`), live quota history chart, and diagnostics.
     - **Context Inspector**: Session hero card + 4 pulse tiles, exact `20×5` **100-Cell Context Window Grid**, active category breakdown, full-width **Context Growth & Compaction Checkpoints** chart, tool context consumers, clickable heaviest steps, subagent rollups, and filterable per-step telemetry (`All / LLM / Tools / Checkpoints`).
     - **Models & Tools**: Rich Model Efficiency breakdown (inline cache pills + proportional share bars), Global Tool Context Bloat ranking, and Account Available Models (`agy models`).
     - **Sessions & Settings**: Searchable cross-surface session ledger (`APP / CLI / IDE`) with color-coded `Used %` pills, Floating Widget shape/dock/4-corner anchor/size/opacity/theme/startup controls, calibrated 5h/7d estimated baselines, and **1-click `Auto-Configure CLI statusLine`**.

---

## How Data Is Collected

- **Desktop conversation tracking** reads the Antigravity App window title and matches it against titles in the local `conversation_summaries.db`, opened read-only. Switching between existing chats updates the widget and the Context Inspector in Auto mode without requiring a new message. Select a conversation manually when the window title is unavailable or ambiguous.
- **Context usage** comes from the latest recorded input and cache-read counts in each chat's transcript, or from the CLI's reported context percentage when available. Immediately after a compaction, the transcript view uses the checkpoint summary until the next measured model call.
- **Account quotas** are read automatically from the running Antigravity App's local language server while the App is signed in. UsageOrb checks about once a minute and uses the quota buckets for the displayed model. Antigravity must be able to load **Settings → Models**. An unreported or expired quota appears as `—`. To display a local estimate, enter an optional 5h or 7d token budget in **Sessions & Settings**. Estimates use rolling transcript totals.
- **CLI sessions** can optionally provide their own context and quotas through `/statusline`. The desktop quota feed takes precedence when available.

---

## Build & Run

Requires the [.NET 8 SDK / Desktop Runtime](https://dotnet.microsoft.com/download/dotnet/8.0) on Windows.

Run the PowerShell commands below from the project root.

```powershell
.\build.ps1
```

Launch the floating widget (starts quietly beside Antigravity and in the system tray):

```powershell
.\dist\UsageOrb.exe
```

Launch and immediately open the Management Console:

```powershell
.\dist\UsageOrb.exe --console
```

### Optional CLI integration (`agy`)

Click **Auto-Configure CLI statusLine** in **Sessions & Settings**, or run the command below once inside `agy`. Replace `D:/path/to/UsageOrb` with your UsageOrb directory.

```text
/statusline "D:/path/to/UsageOrb/dist/UsageOrb.exe" --statusline
```

---

## Controls & Shortcuts

- **Hover widget**: Show Obsidian Glass Hover Mini-Card with Big-3 progress bars.
- **Left-click widget**: Toggle Click Popover (`Esc` or click outside to dismiss).
- **Drag widget**: Reposition relative to Antigravity (auto-snaps to nearest corner offset) or anywhere in Free Float mode.
- **Right-click widget / System Tray**: Open Management Console, switch **Circular Orb ↔ 3-Metric Pill**, switch dock mode, refresh now, reset position, toggle `Start with Windows`, or exit.
