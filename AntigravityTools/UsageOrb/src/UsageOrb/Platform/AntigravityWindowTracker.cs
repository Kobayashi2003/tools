using System.Collections.Concurrent;
using System.Diagnostics;
using System.Windows.Threading;
using UsageOrb.Core;

namespace UsageOrb.Platform;

public sealed record TrackedWindowState(
    bool IsFound,
    bool IsVisibleAndUnoccluded,
    IntPtr Hwnd,
    NativeMethods.RECT PhysicalBounds,
    double DpiScale,
    string WindowTitle = "",
    AntigravitySurface? Surface = null);

/// <summary>
/// Tracks visible Antigravity desktop/IDE windows in real time using Win32 WinEventHooks
/// so the floating orb stays cleanly anchored to the Antigravity window and hides automatically
/// when Antigravity is minimized or covered.
/// </summary>
public sealed class AntigravityWindowTracker : IDisposable
{
    private readonly uint _ownPid = (uint)Environment.ProcessId;
    private readonly ConcurrentDictionary<uint, string> _processNameCache = new();
    private readonly List<IntPtr> _hooks = [];
    private readonly NativeMethods.WinEventDelegate _eventCallback;
    private readonly DispatcherTimer _fallbackTimer;
    private IntPtr _lastTrackedHwnd = IntPtr.Zero;
    private TrackedWindowState _currentState = new(false, false, IntPtr.Zero, default, 1.0);
    private bool _disposed;

    public event Action<TrackedWindowState>? StateChanged;

    public TrackedWindowState CurrentState => _currentState;

    public AntigravityWindowTracker()
    {
        // Keep delegate rooted for lifetime of WinEventHook
        _eventCallback = OnWinEvent;

        RegisterHook(NativeMethods.EVENT_SYSTEM_FOREGROUND, NativeMethods.EVENT_SYSTEM_FOREGROUND);
        RegisterHook(NativeMethods.EVENT_SYSTEM_MOVESIZEEND, NativeMethods.EVENT_SYSTEM_MOVESIZEEND);
        RegisterHook(NativeMethods.EVENT_SYSTEM_MINIMIZESTART, NativeMethods.EVENT_SYSTEM_MINIMIZEEND);
        RegisterHook(NativeMethods.EVENT_OBJECT_LOCATIONCHANGE, NativeMethods.EVENT_OBJECT_NAMECHANGE);
        RegisterHook(NativeMethods.EVENT_OBJECT_DESTROY, NativeMethods.EVENT_OBJECT_DESTROY);

        _fallbackTimer = new DispatcherTimer(DispatcherPriority.Background)
        {
            Interval = TimeSpan.FromMilliseconds(450),
        };
        _fallbackTimer.Tick += (_, _) => EvaluateNow();
        _fallbackTimer.Start();

        EvaluateNow();
    }

    private void RegisterHook(uint min, uint max)
    {
        var hook = NativeMethods.SetWinEventHook(
            min,
            max,
            IntPtr.Zero,
            _eventCallback,
            0,
            0,
            NativeMethods.WINEVENT_OUTOFCONTEXT | NativeMethods.WINEVENT_SKIPOWNPROCESS);
        if (hook != IntPtr.Zero)
        {
            _hooks.Add(hook);
        }
    }

    private void OnWinEvent(
        IntPtr hWinEventHook,
        uint eventType,
        IntPtr hwnd,
        int idObject,
        int idChild,
        uint dwEventThread,
        uint dwmsEventTime)
    {
        if (_disposed) return;

        // Filter noisy child-object location/name events (OBJID_WINDOW == 0)
        if (eventType is NativeMethods.EVENT_OBJECT_LOCATIONCHANGE or NativeMethods.EVENT_OBJECT_NAMECHANGE &&
            (idObject != 0 || hwnd != _lastTrackedHwnd))
        {
            return;
        }

        if (eventType == NativeMethods.EVENT_OBJECT_DESTROY && idObject != 0)
        {
            return;
        }

        EvaluateNow();
    }

    public void EvaluateNow()
    {
        if (_disposed) return;

        var targetHwnd = FindBestAntigravityWindow();
        _lastTrackedHwnd = targetHwnd;

        TrackedWindowState next;
        if (targetHwnd == IntPtr.Zero ||
            !NativeMethods.IsWindow(targetHwnd) ||
            !NativeMethods.IsWindowVisible(targetHwnd) ||
            NativeMethods.IsIconic(targetHwnd) ||
            !NativeMethods.TryGetExtendedWindowBounds(targetHwnd, out var rect) ||
            rect.Width < 260 ||
            rect.Height < 200)
        {
            next = new TrackedWindowState(false, false, IntPtr.Zero, default, 1.0);
        }
        else
        {
            double dpiScale = NativeMethods.GetDpiScaleForWindow(targetHwnd);
            bool unoccluded = IsWindowEffectivelyVisible(targetHwnd, rect);
            string title = NativeMethods.GetWindowTitle(targetHwnd);
            NativeMethods.GetWindowThreadProcessId(targetHwnd, out uint pid);
            var process = GetProcessName(pid);
            AntigravitySurface? surface = process.ToLowerInvariant() switch
            {
                "antigravity" => AntigravitySurface.App,
                "antigravity-ide" => AntigravitySurface.Ide,
                "agy" or "antigravity-cli" => AntigravitySurface.Cli,
                _ => null,
            };
            next = new TrackedWindowState(true, unoccluded, targetHwnd, rect, dpiScale, title, surface);
        }

        if (!StatesEqual(_currentState, next))
        {
            _currentState = next;
            StateChanged?.Invoke(next);
        }
    }

    private IntPtr FindBestAntigravityWindow()
    {
        var fg = NativeMethods.GetForegroundWindow();
        if (fg != IntPtr.Zero && IsAntigravityWindow(fg, out _))
        {
            return fg;
        }

        if (_lastTrackedHwnd != IntPtr.Zero &&
            NativeMethods.IsWindow(_lastTrackedHwnd) &&
            NativeMethods.IsWindowVisible(_lastTrackedHwnd) &&
            !NativeMethods.IsIconic(_lastTrackedHwnd) &&
            IsAntigravityWindow(_lastTrackedHwnd, out _))
        {
            return _lastTrackedHwnd;
        }

        IntPtr bestProcessMatch = IntPtr.Zero;
        IntPtr bestTitleMatch = IntPtr.Zero;

        NativeMethods.EnumWindows((hwnd, _) =>
        {
            if (!NativeMethods.IsWindowVisible(hwnd) || NativeMethods.IsIconic(hwnd)) return true;
            if (!IsAntigravityWindow(hwnd, out bool exactProcessMatch)) return true;

            if (!NativeMethods.TryGetExtendedWindowBounds(hwnd, out var rect) || rect.Width < 260 || rect.Height < 200)
            {
                return true;
            }

            if (exactProcessMatch && bestProcessMatch == IntPtr.Zero)
            {
                bestProcessMatch = hwnd;
                return false;
            }

            if (!exactProcessMatch && bestTitleMatch == IntPtr.Zero)
            {
                bestTitleMatch = hwnd;
            }

            return true;
        }, IntPtr.Zero);

        return bestProcessMatch != IntPtr.Zero ? bestProcessMatch : bestTitleMatch;
    }

    private bool IsAntigravityWindow(IntPtr hwnd, out bool exactProcessMatch)
    {
        exactProcessMatch = false;
        _ = NativeMethods.GetWindowThreadProcessId(hwnd, out uint pid);
        if (pid == 0 || pid == _ownPid) return false;

        var procName = GetProcessName(pid);
        if (procName.Contains("usageorb", StringComparison.OrdinalIgnoreCase)) return false;

        if (procName.Contains("antigravity", StringComparison.OrdinalIgnoreCase))
        {
            exactProcessMatch = true;
            return true;
        }

        // Fallback for IDE/terminal hosts displaying Antigravity in the title (excluding browsers)
        if (procName is "chrome" or "msedge" or "firefox" or "brave" or "opera" or "vivaldi")
        {
            return false;
        }

        var title = NativeMethods.GetWindowTitle(hwnd);
        if (title.Contains("Antigravity", StringComparison.OrdinalIgnoreCase) &&
            !title.Contains("UsageOrb", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        return false;
    }

    private bool IsWindowEffectivelyVisible(IntPtr targetHwnd, NativeMethods.RECT rect)
    {
        var fg = NativeMethods.GetForegroundWindow();
        if (fg == targetHwnd) return true;

        if (fg != IntPtr.Zero)
        {
            _ = NativeMethods.GetWindowThreadProcessId(fg, out uint fgPid);
            if (fgPid == _ownPid) return true;
        }

        // Check a few anchor sample points inside the Antigravity window to see whether
        // another window is covering it (e.g., maximized app in front on same monitor)
        var probes = new NativeMethods.POINT[]
        {
            new() { X = rect.Left + Math.Min(48, rect.Width / 4), Y = rect.Bottom - Math.Min(48, rect.Height / 4) },
            new() { X = rect.Right - Math.Min(48, rect.Width / 4), Y = rect.Bottom - Math.Min(48, rect.Height / 4) },
            new() { X = rect.Left + rect.Width / 2, Y = rect.Top + Math.Min(40, rect.Height / 4) },
        };

        foreach (var pt in probes)
        {
            var hit = NativeMethods.WindowFromPoint(pt);
            if (hit == IntPtr.Zero) continue;
            var root = NativeMethods.GetAncestor(hit, NativeMethods.GA_ROOT);
            if (root == targetHwnd) return true;
            _ = NativeMethods.GetWindowThreadProcessId(root, out uint hitPid);
            if (hitPid == _ownPid) return true;
        }

        return false;
    }

    private string GetProcessName(uint pid)
    {
        if (_processNameCache.TryGetValue(pid, out var cached)) return cached;

        string name = string.Empty;
        try
        {
            using var proc = Process.GetProcessById((int)pid);
            name = proc.ProcessName;
        }
        catch
        {
            // Process may have exited or require elevation
        }

        if (_processNameCache.Count > 256) _processNameCache.Clear();
        _processNameCache[pid] = name;
        return name;
    }

    private static bool StatesEqual(TrackedWindowState a, TrackedWindowState b) =>
        a.IsFound == b.IsFound &&
        a.IsVisibleAndUnoccluded == b.IsVisibleAndUnoccluded &&
        a.Hwnd == b.Hwnd &&
        a.Surface == b.Surface &&
        Math.Abs(a.DpiScale - b.DpiScale) < 0.001 &&
        a.PhysicalBounds.Left == b.PhysicalBounds.Left &&
        a.PhysicalBounds.Top == b.PhysicalBounds.Top &&
        a.PhysicalBounds.Right == b.PhysicalBounds.Right &&
        a.PhysicalBounds.Bottom == b.PhysicalBounds.Bottom &&
        string.Equals(a.WindowTitle, b.WindowTitle, StringComparison.Ordinal);

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _fallbackTimer.Stop();
        foreach (var hook in _hooks)
        {
            NativeMethods.UnhookWinEvent(hook);
        }

        _hooks.Clear();
    }
}
