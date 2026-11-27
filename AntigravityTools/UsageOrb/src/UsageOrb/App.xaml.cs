using System.Windows;
using System.Windows.Interop;
using System.Windows.Threading;
using UsageOrb.Core;
using UsageOrb.Platform;
using UsageOrb.Services;
using UsageOrb.UI;

namespace UsageOrb;

public partial class App : System.Windows.Application
{
    private AppSettings _settings = new();
    private ThemeService? _themeService;
    private TelemetryMonitorService? _telemetryService;
    private AntigravityWindowTracker? _windowTracker;
    private TrayIconManager? _trayManager;
    private FloatingOrbWindow? _orbWindow;
    private HoverTooltipWindow? _hoverWindow;
    private PopoverWindow? _popoverWindow;
    private ManagementWindow? _managementWindow;
    private EventWaitHandle? _wakeEvent;
    private CancellationTokenSource? _wakeCts;
    private string? _pinnedConversationId;
    private TrackedWindowState? _lastTrackedWindow;
    private DispatcherTimer? _lifecycleTimer;
    private bool _runtimeActive;
    private readonly bool _openConsoleOnStartup;
    private readonly bool _backgroundStartup;

    public App(bool openConsoleOnStartup = false, bool backgroundStartup = false)
    {
        _openConsoleOnStartup = openConsoleOnStartup;
        _backgroundStartup = backgroundStartup;
    }

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        _settings = SettingsStore.LoadSettings();
        _settings.StartWithWindows = StartupManager.IsEnabled();
        if (_settings.RegisterStartMenuShortcut) StartMenuShortcut.TrySetRegistration(enabled: true);

        _themeService = new ThemeService();
        _themeService.ThemeChanged += isDark =>
        {
            _orbWindow?.UpdateTheme(isDark);
            _managementWindow?.UpdateTheme(isDark);
        };
        _themeService.Apply(_settings.Theme);

        _orbWindow = new FloatingOrbWindow(_settings);
        _orbWindow.UpdateTheme(_themeService.IsDark);

        _hoverWindow = new HoverTooltipWindow();
        _popoverWindow = new PopoverWindow();
        _managementWindow = new ManagementWindow(_settings);
        _managementWindow.UpdateTheme(_themeService.IsDark);
        _orbWindow.IsVisibleChanged += (_, _) =>
        {
            if (_orbWindow.IsVisible) return;
            if (_hoverWindow.IsVisible) _hoverWindow.Hide();
            if (_popoverWindow.IsVisible) _popoverWindow.Hide();
        };

        // Wire orb interactions
        _orbWindow.HoverStarted += () =>
        {
            if (_popoverWindow.IsVisible) return;
            var snapshot = _telemetryService?.LatestSnapshot;
            _hoverWindow.UpdateContent(snapshot, _settings, ResolveDisplaySession(snapshot));
            _hoverWindow.ShowNear(_orbWindow);
        };
        _orbWindow.HoverEnded += () =>
        {
            if (_hoverWindow.IsVisible) _hoverWindow.Hide();
        };
        _orbWindow.DragStarted += () =>
        {
            if (_hoverWindow.IsVisible) _hoverWindow.Hide();
            if (_popoverWindow.IsVisible) _popoverWindow.Hide();
        };
        _orbWindow.Clicked += () =>
        {
            if (_hoverWindow.IsVisible) _hoverWindow.Hide();
            if (_popoverWindow.IsVisible || _popoverWindow.WasJustDismissed)
            {
                _popoverWindow.Hide();
                return;
            }

            var snapshot = _telemetryService?.LatestSnapshot;
            var resolved = ResolveDisplaySession(snapshot);
            _popoverWindow.UpdateData(snapshot is null ? null : AnalyticsEngine.ForDisplaySession(snapshot, resolved.Session, _settings),
                _settings, resolved, _pinnedConversationId);
            _popoverWindow.ShowNear(_orbWindow);
        };
        _orbWindow.PositionCommitted += ApplyAndSaveSettings;
        _orbWindow.OpenConsoleRequested += OpenManagementConsole;
        _orbWindow.SessionSelectionRequested += SetPinnedSession;
        _orbWindow.WidgetShapeRequested += shape =>
        {
            var next = _settings.Clone();
            next.WidgetShape = shape;
            ApplyAndSaveSettings(next);
        };
        _orbWindow.DockModeRequested += mode =>
        {
            var next = _settings.Clone();
            next.DockMode = mode;
            ApplyAndSaveSettings(next);
        };
        _orbWindow.RefreshRequested += () => _telemetryService?.RefreshNow();
        _orbWindow.ResetPositionRequested += ResetOrbPosition;
        _orbWindow.HideOrbRequested += () =>
        {
            var next = _settings.Clone();
            next.OrbVisible = false;
            ApplyAndSaveSettings(next);
        };
        _orbWindow.ExitRequested += ShutdownApp;

        // Wire popover actions
        _popoverWindow.ManageUsageRequested += OpenManagementConsole;
        _popoverWindow.RefreshRequested += () => _telemetryService?.RefreshNow();
        _popoverWindow.SessionSelectionChanged += SetPinnedSession;

        // Wire management console actions
        _managementWindow.SettingsSaved += ApplyConsoleSettings;
        _managementWindow.ResetPositionRequested += ResetOrbPosition;
        _managementWindow.RefreshRequested += () => _telemetryService?.RefreshNow();
        _managementWindow.SessionPinRequested += SetPinnedSession;

        // Wire system tray
        _trayManager = new TrayIconManager();
        _trayManager.OpenConsoleRequested += () => Dispatcher.BeginInvoke(OpenManagementConsole);
        _trayManager.ToggleOrbRequested += () => Dispatcher.BeginInvoke(() =>
        {
            var next = _settings.Clone();
            next.OrbVisible = !next.OrbVisible;
            ApplyAndSaveSettings(next);
        });
        _trayManager.WidgetShapeRequested += shape => Dispatcher.BeginInvoke(() =>
        {
            var next = _settings.Clone();
            next.WidgetShape = shape;
            ApplyAndSaveSettings(next);
        });
        _trayManager.DockModeRequested += mode => Dispatcher.BeginInvoke(() =>
        {
            var next = _settings.Clone();
            next.DockMode = mode;
            ApplyAndSaveSettings(next);
        });
        _trayManager.ResetPositionRequested += () => Dispatcher.BeginInvoke(ResetOrbPosition);
        _trayManager.StartWithWindowsRequested += enabled => Dispatcher.BeginInvoke(() =>
        {
            var next = _settings.Clone();
            next.StartWithWindows = enabled;
            ApplyAndSaveSettings(next);
        });
        _trayManager.ExitRequested += () => Dispatcher.BeginInvoke(ShutdownApp);
        _trayManager.UpdateState(_settings, null, null);

        // Track Antigravity desktop/IDE windows (position + live window title for smart session matching)
        _windowTracker = new AntigravityWindowTracker(IsOverlayInteraction, _orbWindow.GetDockedBounds);
        _lastTrackedWindow = _windowTracker.CurrentState;
        _windowTracker.StateChanged += tracked => Dispatcher.BeginInvoke(() =>
        {
            if (tracked != _windowTracker?.CurrentState) return;
            _orbWindow?.UpdateTrackedWindow(tracked);

            var previous = _lastTrackedWindow;
            _lastTrackedWindow = tracked;
            if (_pinnedConversationId is null &&
                (previous?.Hwnd != tracked.Hwnd || previous.Surface != tracked.Surface || previous.WindowTitle != tracked.WindowTitle))
            {
                BroadcastSnapshot();
            }
        });
        _lifecycleTimer = new DispatcherTimer(DispatcherPriority.Background) { Interval = TimeSpan.FromMilliseconds(750) };
        _lifecycleTimer.Tick += (_, _) => UpdateLifecycle(closeConsole: true);
        UpdateLifecycle(closeConsole: false);
        _orbWindow.UpdateTrackedWindow(_windowTracker.CurrentState);

        StartSingleInstanceWakeListener();

        if (_openConsoleOnStartup || (!_backgroundStartup && (!_settings.ShowTrayIcon || !_runtimeActive)))
        {
            OpenManagementConsole();
        }
    }

    private bool IsOverlayInteraction(IntPtr foreground)
    {
        if (foreground == IntPtr.Zero) return false;
        NativeMethods.GetWindowThreadProcessId(foreground, out uint pid);
        if (pid != (uint)Environment.ProcessId) return false;
        if (_managementWindow is { } console && foreground == new WindowInteropHelper(console).Handle) return false;
        return _popoverWindow?.IsVisible == true || _orbWindow?.IsContextMenuOpen == true;
    }

    private void UpdateLifecycle(bool closeConsole)
    {
        _lifecycleTimer!.IsEnabled = _settings.FollowAntigravityLifecycle;
        bool active = !_settings.FollowAntigravityLifecycle || AntigravityDesktop.IsRunning();
        _windowTracker?.SetSuspended(!active);
        _orbWindow?.SetLifecycleActive(active);
        _trayManager?.SetVisible(active && _settings.ShowTrayIcon);
        if (active == _runtimeActive) return;
        _runtimeActive = active;

        if (active)
        {
            _telemetryService = new TelemetryMonitorService(_settings);
            _telemetryService.SnapshotUpdated += _ => Dispatcher.BeginInvoke(BroadcastSnapshot);
        }
        else
        {
            var lastSnapshot = _telemetryService?.LatestSnapshot;
            _telemetryService?.Dispose();
            _telemetryService = null;
            if (closeConsole) _managementWindow?.Hide();
            if (lastSnapshot?.DesktopQuotaLastSeenAt is not null)
            {
                var pausedSnapshot = lastSnapshot with
                {
                    DesktopQuotaLastSeenAt = null,
                    QuotaBuckets = [],
                    QuotaHistory = [],
                };
                var resolved = SessionResolver.Resolve(pausedSnapshot, _pinnedConversationId, trackedWindowTitle: null);
                _managementWindow?.UpdateSnapshot(AnalyticsEngine.ForDisplaySession(pausedSnapshot, resolved.Session, _settings),
                    resolved, _pinnedConversationId);
            }
        }
    }

    private ResolvedDisplaySession ResolveDisplaySession(DashboardSnapshot? snapshot) =>
        SessionResolver.Resolve(
            snapshot,
            _pinnedConversationId,
            _windowTracker?.CurrentState.WindowTitle,
            _windowTracker?.CurrentState.Surface);

    private void SetPinnedSession(string? conversationId)
    {
        _pinnedConversationId = string.IsNullOrWhiteSpace(conversationId) ? null : conversationId;
        BroadcastSnapshot();
    }

    private void BroadcastSnapshot()
    {
        var snapshot = _telemetryService?.LatestSnapshot;
        if (snapshot is null) return;

        var resolved = ResolveDisplaySession(snapshot);
        snapshot = AnalyticsEngine.ForDisplaySession(snapshot, resolved.Session, _settings);
        _orbWindow?.UpdateSnapshot(snapshot, resolved, _pinnedConversationId);
        _trayManager?.UpdateState(_settings, snapshot, resolved);
        if (_hoverWindow?.IsVisible == true) _hoverWindow.UpdateContent(snapshot, _settings, resolved);
        if (_popoverWindow?.IsVisible == true) _popoverWindow.UpdateData(snapshot, _settings, resolved, _pinnedConversationId);
        if (_managementWindow?.IsVisible == true) _managementWindow.UpdateSnapshot(snapshot, resolved, _pinnedConversationId);
    }

    private void StartSingleInstanceWakeListener()
    {
        try
        {
            _wakeEvent = new EventWaitHandle(false, EventResetMode.AutoReset, Program.WakeEventName);
            _wakeCts = new CancellationTokenSource();
            var token = _wakeCts.Token;
            Task.Run(() =>
            {
                while (!token.IsCancellationRequested)
                {
                    if (_wakeEvent.WaitOne(500))
                    {
                        Dispatcher.BeginInvoke(OpenManagementConsole);
                    }
                }
            }, token);
        }
        catch
        {
            // Non-critical if wake IPC cannot be created
        }
    }

    private void ApplyConsoleSettings(AppSettings next)
    {
        bool wasRegistered = _settings.RegisterStartMenuShortcut;
        if ((wasRegistered || next.RegisterStartMenuShortcut) &&
            StartMenuShortcut.TrySetRegistration(next.RegisterStartMenuShortcut) is { } shortcutError)
        {
            _managementWindow?.ShowToast(shortcutError);
            return;
        }

        try
        {
            ApplyAndSaveSettings(next);
            _managementWindow?.ShowToast("Preferences saved.");
        }
        catch (Exception ex) when (ex is System.IO.IOException or UnauthorizedAccessException)
        {
            if (wasRegistered != next.RegisterStartMenuShortcut) StartMenuShortcut.TrySetRegistration(wasRegistered);
            _managementWindow?.ShowToast("Preferences could not be saved.");
        }
    }

    private void ApplyAndSaveSettings(AppSettings next)
    {
        _settings = SettingsStore.SaveSettings(next);
        StartupManager.SetEnabled(_settings.StartWithWindows, _settings.FollowAntigravityLifecycle);
        _themeService?.Apply(_settings.Theme);
        _telemetryService?.UpdateSettings(_settings);
        _orbWindow?.UpdateSettings(_settings);
        _managementWindow?.UpdateSettings(_settings);
        _windowTracker?.EvaluateNow();
        UpdateLifecycle(closeConsole: false);
        BroadcastSnapshot();
    }

    private void ResetOrbPosition()
    {
        var next = _settings.Clone();
        next.AnchorCorner = OrbAnchorCorner.BottomLeft;
        next.AnchorOffsetX = 14;
        next.AnchorOffsetY = 16;
        next.FreeFloatX = -1;
        next.FreeFloatY = -1;
        next.OrbVisible = true;
        ApplyAndSaveSettings(next);
    }

    private void OpenManagementConsole()
    {
        if (_managementWindow is null) return;
        if (_telemetryService?.LatestSnapshot is { } snap)
        {
            var resolved = ResolveDisplaySession(snap);
            _managementWindow.UpdateSnapshot(AnalyticsEngine.ForDisplaySession(snap, resolved.Session, _settings), resolved, _pinnedConversationId);
        }

        if (!_managementWindow.IsVisible)
        {
            _managementWindow.Show();
        }

        if (_managementWindow.WindowState == WindowState.Minimized)
        {
            _managementWindow.WindowState = WindowState.Normal;
        }

        _managementWindow.Activate();
    }

    private void ShutdownApp()
    {
        _wakeCts?.Cancel();
        _lifecycleTimer?.Stop();
        _wakeEvent?.Dispose();
        _telemetryService?.Dispose();
        _windowTracker?.Dispose();
        _trayManager?.Dispose();
        _themeService?.Dispose();

        _hoverWindow?.Close();
        _popoverWindow?.Close();
        _orbWindow?.Close();
        Shutdown(0);
    }
}
