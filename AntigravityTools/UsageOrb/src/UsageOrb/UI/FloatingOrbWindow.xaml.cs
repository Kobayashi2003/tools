using System.Windows;
using System.Windows.Controls;
using System.Windows.Forms;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Threading;
using UsageOrb.Core;
using UsageOrb.Platform;

namespace UsageOrb.UI;

public partial class FloatingOrbWindow : Window
{
    private const double PillWindowWidth = 236;
    private const double PillWindowHeight = 36;

    private readonly DispatcherTimer _hoverDelayTimer;
    private AppSettings _settings;
    private DashboardSnapshot? _snapshot;
    private ResolvedDisplaySession? _displaySession;
    private string? _pinnedConversationId;
    private TrackedWindowState _trackedWindow = new(false, false, IntPtr.Zero, default, 1.0);
    private bool _isDark = true;
    private bool _isMouseDown;
    private bool _isDragging;
    private bool _lifecycleActive = true;
    private ContextMenu? _openContextMenu;
    private System.Windows.Point _mouseDownScreenDip;
    private double _dragStartLeft;
    private double _dragStartTop;

    public event Action? Clicked;
    public event Action? HoverStarted;
    public event Action? HoverEnded;
    public event Action? DragStarted;
    public event Action<AppSettings>? PositionCommitted;
    public event Action? OpenConsoleRequested;
    public event Action<string?>? SessionSelectionRequested;
    public event Action<FloatingWidgetShape>? WidgetShapeRequested;
    public event Action<OrbDockMode>? DockModeRequested;
    public event Action? ResetPositionRequested;
    public event Action? HideOrbRequested;
    public event Action? RefreshRequested;
    public event Action? ExitRequested;

    public bool IsContextMenuOpen => _openContextMenu?.IsOpen == true;

    public FloatingOrbWindow(AppSettings initialSettings)
    {
        InitializeComponent();
        _settings = initialSettings.Clone();
        ApplyShapeSizeAndOpacity(hovered: false);

        _hoverDelayTimer = new DispatcherTimer
        {
            Interval = TimeSpan.FromMilliseconds(200),
        };
        _hoverDelayTimer.Tick += (_, _) =>
        {
            _hoverDelayTimer.Stop();
            if (!_isDragging && IsMouseOver)
            {
                HoverStarted?.Invoke();
            }
        };

        SourceInitialized += (_, _) =>
        {
            var hwnd = new WindowInteropHelper(this).Handle;
            NativeMethods.ApplyOverlayWindowStyles(hwnd, noActivate: true);
        };

        MouseEnter += OnOrbMouseEnter;
        MouseLeave += OnOrbMouseLeave;
        MouseLeftButtonDown += OnOrbMouseLeftButtonDown;
        MouseMove += OnOrbMouseMove;
        MouseLeftButtonUp += OnOrbMouseLeftButtonUp;
        MouseRightButtonUp += OnOrbMouseRightButtonUp;
    }

    public void UpdateTheme(bool isDark)
    {
        _isDark = isDark;
        RedrawWidget();
    }

    public void UpdateSettings(AppSettings settings)
    {
        _settings = settings.Clone();
        ApplyShapeSizeAndOpacity(hovered: IsMouseOver);
        RedrawWidget();
        UpdatePlacementAndVisibility();
    }

    public void UpdateSnapshot(DashboardSnapshot snapshot, ResolvedDisplaySession? displaySession = null, string? pinnedConversationId = null)
    {
        _snapshot = snapshot;
        _displaySession = displaySession;
        _pinnedConversationId = pinnedConversationId;
        RedrawWidget();
    }

    public void UpdateTrackedWindow(TrackedWindowState tracked)
    {
        _trackedWindow = tracked;
        if (!_isDragging || (_settings.DockMode == OrbDockMode.FollowAntigravity && !tracked.IsVisibleAndUnoccluded))
        {
            UpdatePlacementAndVisibility();
        }
    }

    internal void SetLifecycleActive(bool active)
    {
        if (active == _lifecycleActive) return;
        _lifecycleActive = active;
        UpdatePlacementAndVisibility();
    }

    private void ApplyShapeSizeAndOpacity(bool hovered)
    {
        bool isPill = _settings.WidgetShape == FloatingWidgetShape.CompactPill;
        OrbCanvas.Visibility = isPill ? Visibility.Collapsed : Visibility.Visible;
        PillContainer.Visibility = isPill ? Visibility.Visible : Visibility.Collapsed;

        double targetW = isPill ? PillWindowWidth : _settings.OrbSizePx + 6;
        double targetH = isPill ? PillWindowHeight : _settings.OrbSizePx + 6;
        if (Math.Abs(Width - targetW) > 0.1 || Math.Abs(Height - targetH) > 0.1)
        {
            Width = targetW;
            Height = targetH;
        }

        if (isPill)
        {
            PillContainer.BorderBrush = TryFindResource(hovered ? "BorderStrongBrush" : "BorderPrimaryBrush") as System.Windows.Media.Brush;
        }

        Opacity = hovered ? 1.0 : _settings.IdleOpacity;
    }

    private void RedrawWidget()
    {
        var session = _displaySession?.Session ?? _snapshot?.ActiveSession;
        double? ctxPct = session?.ContextUsedPercent;
        bool writing = session?.IsRecentlyWriting == true;

        QuotaWindowSummary? q5 = null;
        QuotaWindowSummary? q7 = null;
        if (_snapshot is not null)
        {
            (q5, q7) = QuotaResolver.Resolve(_snapshot, _settings, session: session);
        }

        OrbCanvas.UpdateMetrics(
            ctxPct,
            q5?.RemainingPercent ?? 0,
            writing,
            _settings.ContextWarnPercent,
            _settings.ContextCriticalPercent,
            _settings.QuotaLowPercent,
            _isDark);

        PillCtxVal.Text = ctxPct is double pct ? $"{pct:0}%" : "—";
        Pill5hVal.Text = q5?.FormatPercent() ?? "—";
        PillWkVal.Text = q7?.FormatPercent() ?? "—";

        PillCtxDot.Fill = ScreenPlacementHelper.BrushForContext(ctxPct ?? 0, _settings.ContextWarnPercent, _settings.ContextCriticalPercent, this);
        Pill5hDot.Fill = ScreenPlacementHelper.BrushForRemaining(q5?.RemainingPercent, _settings.QuotaLowPercent, this);
        PillWkDot.Fill = ScreenPlacementHelper.BrushForRemaining(q7?.RemainingPercent, _settings.QuotaLowPercent, this);
    }

    public void UpdatePlacementAndVisibility()
    {
        bool followsWindow = _settings.DockMode == OrbDockMode.FollowAntigravity;
        if (!_lifecycleActive || !_settings.OrbVisible ||
            (followsWindow && (!_trackedWindow.IsFound || !_trackedWindow.IsVisibleAndUnoccluded)))
        {
            _hoverDelayTimer.Stop();
            _isMouseDown = false;
            _isDragging = false;
            if (IsMouseCaptured) ReleaseMouseCapture();
            if (_openContextMenu is { } menu) menu.IsOpen = false;
            if (IsVisible) Hide();
            HoverEnded?.Invoke();
            return;
        }

        if (followsWindow)
        {
            var position = GetDockedPosition(_trackedWindow);
            Left = position.X;
            Top = position.Y;
        }
        else
        {
            PositionFreeFloat();
        }
        if (!IsVisible) Show();
    }

    internal NativeMethods.RECT? GetDockedBounds(TrackedWindowState tracked)
    {
        if (_settings.DockMode != OrbDockMode.FollowAntigravity) return null;
        if (_isDragging && NativeMethods.GetWindowRect(new WindowInteropHelper(this).Handle, out var actual)) return actual;
        var position = GetDockedPosition(tracked);
        double scale = tracked.DpiScale;
        return new NativeMethods.RECT
        {
            Left = (int)Math.Round(position.X * scale),
            Top = (int)Math.Round(position.Y * scale),
            Right = (int)Math.Round((position.X + Width) * scale),
            Bottom = (int)Math.Round((position.Y + Height) * scale),
        };
    }

    private System.Windows.Point GetDockedPosition(TrackedWindowState tracked)
    {
        double scale = tracked.DpiScale;
        var r = tracked.PhysicalBounds;

        double winLeft = r.Left / scale;
        double winTop = r.Top / scale;
        double winRight = r.Right / scale;
        double winBottom = r.Bottom / scale;

        double left = _settings.AnchorCorner switch
        {
            OrbAnchorCorner.BottomLeft or OrbAnchorCorner.TopLeft => winLeft + _settings.AnchorOffsetX,
            _ => winRight - Width - _settings.AnchorOffsetX,
        };

        double top = _settings.AnchorCorner switch
        {
            OrbAnchorCorner.TopLeft or OrbAnchorCorner.TopRight => winTop + _settings.AnchorOffsetY,
            _ => winBottom - Height - _settings.AnchorOffsetY,
        };

        ClampToMonitor(ref left, ref top, (r.Left + r.Right) / 2, (r.Top + r.Bottom) / 2, scale);
        return new System.Windows.Point(left, top);
    }

    private void PositionFreeFloat()
    {
        var dpi = VisualTreeHelper.GetDpi(this);
        double scale = dpi.DpiScaleX > 0 ? dpi.DpiScaleX : 1.0;

        if (_settings.FreeFloatX < 0 || _settings.FreeFloatY < 0)
        {
            var wa = Screen.PrimaryScreen?.WorkingArea ?? new System.Drawing.Rectangle(0, 0, 1920, 1080);
            Left = wa.Right / scale - Width - 22;
            Top = wa.Bottom / scale - Height - 28;
            return;
        }

        double left = _settings.FreeFloatX;
        double top = _settings.FreeFloatY;
        ClampToMonitor(ref left, ref top, (int)(left * scale), (int)(top * scale), scale);
        Left = left;
        Top = top;
    }

    private void ClampToMonitor(ref double left, ref double top, int pxX, int pxY, double scale)
    {
        var screen = Screen.FromPoint(new System.Drawing.Point(pxX, pxY));
        var wa = screen.WorkingArea;
        double minX = wa.Left / scale + 2;
        double minY = wa.Top / scale + 2;
        double maxX = Math.Max(minX, wa.Right / scale - Width - 2);
        double maxY = Math.Max(minY, wa.Bottom / scale - Height - 2);
        left = Math.Clamp(left, minX, maxX);
        top = Math.Clamp(top, minY, maxY);
    }

    private void OnOrbMouseEnter(object sender, System.Windows.Input.MouseEventArgs e)
    {
        OrbCanvas.SetHovered(true);
        ApplyShapeSizeAndOpacity(hovered: true);
        if (!_isDragging)
        {
            _hoverDelayTimer.Stop();
            _hoverDelayTimer.Start();
        }
    }

    private void OnOrbMouseLeave(object sender, System.Windows.Input.MouseEventArgs e)
    {
        OrbCanvas.SetHovered(false);
        ApplyShapeSizeAndOpacity(hovered: false);
        _hoverDelayTimer.Stop();
        HoverEnded?.Invoke();
    }

    private void OnOrbMouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        _hoverDelayTimer.Stop();
        HoverEnded?.Invoke();
        _isMouseDown = true;
        _isDragging = false;
        _mouseDownScreenDip = GetCursorScreenDip();
        _dragStartLeft = Left;
        _dragStartTop = Top;
        CaptureMouse();
        e.Handled = true;
    }

    private void OnOrbMouseMove(object sender, System.Windows.Input.MouseEventArgs e)
    {
        if (!_isMouseDown) return;

        var cur = GetCursorScreenDip();
        double dx = cur.X - _mouseDownScreenDip.X;
        double dy = cur.Y - _mouseDownScreenDip.Y;

        if (!_isDragging && (Math.Abs(dx) > 4 || Math.Abs(dy) > 4))
        {
            _isDragging = true;
            DragStarted?.Invoke();
        }

        if (_isDragging)
        {
            Left = _dragStartLeft + dx;
            Top = _dragStartTop + dy;
        }
    }

    private void OnOrbMouseLeftButtonUp(object sender, MouseButtonEventArgs e)
    {
        if (!_isMouseDown) return;
        _isMouseDown = false;
        ReleaseMouseCapture();

        if (_isDragging)
        {
            _isDragging = false;
            PersistDraggedPosition();
        }
        else
        {
            Clicked?.Invoke();
        }

        e.Handled = true;
    }

    private void PersistDraggedPosition()
    {
        var updated = _settings.Clone();
        if (updated.DockMode == OrbDockMode.FollowAntigravity && _trackedWindow.IsFound)
        {
            double scale = _trackedWindow.DpiScale > 0 ? _trackedWindow.DpiScale : 1.0;
            var r = _trackedWindow.PhysicalBounds;
            double winLeft = r.Left / scale;
            double winTop = r.Top / scale;
            double winRight = r.Right / scale;
            double winBottom = r.Bottom / scale;

            double centerX = Left + Width / 2.0;
            double centerY = Top + Height / 2.0;
            bool isRight = centerX > (winLeft + winRight) / 2.0;
            bool isTop = centerY < (winTop + winBottom) / 2.0;

            updated.AnchorCorner = (isTop, isRight) switch
            {
                (true, false) => OrbAnchorCorner.TopLeft,
                (true, true) => OrbAnchorCorner.TopRight,
                (false, true) => OrbAnchorCorner.BottomRight,
                _ => OrbAnchorCorner.BottomLeft,
            };

            updated.AnchorOffsetX = Math.Round(isRight ? (winRight - Width - Left) : (Left - winLeft));
            updated.AnchorOffsetY = Math.Round(isTop ? (Top - winTop) : (winBottom - Height - Top));
        }
        else
        {
            updated.FreeFloatX = Math.Round(Left);
            updated.FreeFloatY = Math.Round(Top);
        }

        _settings = updated;
        PositionCommitted?.Invoke(updated);
    }

    private System.Windows.Point GetCursorScreenDip()
    {
        var pt = System.Windows.Forms.Cursor.Position;
        var dpi = VisualTreeHelper.GetDpi(this);
        double sx = dpi.DpiScaleX > 0 ? dpi.DpiScaleX : 1.0;
        double sy = dpi.DpiScaleY > 0 ? dpi.DpiScaleY : 1.0;
        return new System.Windows.Point(pt.X / sx, pt.Y / sy);
    }

    private void OnOrbMouseRightButtonUp(object sender, MouseButtonEventArgs e)
    {
        _hoverDelayTimer.Stop();
        HoverEnded?.Invoke();

        var menu = new ContextMenu();

        var openItem = new MenuItem { Header = "Manage Usage..." };
        openItem.Click += (_, _) => OpenConsoleRequested?.Invoke();

        // Quick Session Switcher submenu (syncs across Orb, Pill, Hover, Popover & Console)
        var sessionMenu = new MenuItem { Header = "Active Session  ▸" };
        bool isAuto = string.IsNullOrWhiteSpace(_pinnedConversationId);
        var autoItem = new MenuItem { Header = (isAuto ? "✓ " : "   ") + "Auto (Smart Follow)" };
        autoItem.Click += (_, _) => SessionSelectionRequested?.Invoke(null);
        sessionMenu.Items.Add(autoItem);

        if (_snapshot is { Sessions.Count: > 0 })
        {
            sessionMenu.Items.Add(new Separator());
            foreach (var s in _snapshot.Sessions.Where(x => !x.IsSubagent).Take(8))
            {
                bool isPinnedHere = !isAuto && string.Equals(s.ConversationId, _pinnedConversationId, StringComparison.OrdinalIgnoreCase);
                bool isResolvedHere = isAuto && string.Equals(s.ConversationId, _displaySession?.Session?.ConversationId, StringComparison.OrdinalIgnoreCase);
                string prefix = isPinnedHere ? "✓ " : (isResolvedHere ? "● " : "   ");
                string shortTitle = s.Title.Length > 34 ? s.Title[..31] + "..." : s.Title;
                var convId = s.ConversationId;
                var item = new MenuItem { Header = $"{prefix}{shortTitle} ({s.ContextUsedPercent:0}%)" };
                item.Click += (_, _) => SessionSelectionRequested?.Invoke(convId);
                sessionMenu.Items.Add(item);
            }
        }

        var shapeItem = new MenuItem
        {
            Header = _settings.WidgetShape == FloatingWidgetShape.CircularOrb
                ? "Switch to 3-Metric Pill"
                : "Switch to Circular Orb",
        };
        shapeItem.Click += (_, _) => WidgetShapeRequested?.Invoke(
            _settings.WidgetShape == FloatingWidgetShape.CircularOrb
                ? FloatingWidgetShape.CompactPill
                : FloatingWidgetShape.CircularOrb);

        var modeItem = new MenuItem
        {
            Header = _settings.DockMode == OrbDockMode.FollowAntigravity
                ? "Switch to Free Float"
                : "Switch to Follow Antigravity",
        };
        modeItem.Click += (_, _) => DockModeRequested?.Invoke(
            _settings.DockMode == OrbDockMode.FollowAntigravity
                ? OrbDockMode.FreeFloat
                : OrbDockMode.FollowAntigravity);

        var refreshItem = new MenuItem { Header = "Refresh Now (0 Tokens)" };
        refreshItem.Click += (_, _) => RefreshRequested?.Invoke();

        var resetItem = new MenuItem { Header = "Reset Position" };
        resetItem.Click += (_, _) => ResetPositionRequested?.Invoke();

        var hideItem = new MenuItem { Header = "Hide Widget (keep in tray)" };
        hideItem.Click += (_, _) => HideOrbRequested?.Invoke();

        var exitItem = new MenuItem { Header = "Exit UsageOrb" };
        exitItem.Click += (_, _) => ExitRequested?.Invoke();

        menu.Items.Add(openItem);
        menu.Items.Add(sessionMenu);
        menu.Items.Add(new Separator());
        menu.Items.Add(shapeItem);
        menu.Items.Add(modeItem);
        menu.Items.Add(refreshItem);
        menu.Items.Add(resetItem);
        menu.Items.Add(hideItem);
        menu.Items.Add(new Separator());
        menu.Items.Add(exitItem);

        menu.PlacementTarget = this;
        _openContextMenu = menu;
        menu.Closed += (_, _) => { if (_openContextMenu == menu) _openContextMenu = null; };
        menu.IsOpen = true;
        e.Handled = true;
    }
}
