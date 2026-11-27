using System.Drawing;
using System.Windows.Forms;
using UsageOrb.Core;

namespace UsageOrb.Platform;

public sealed class TrayIconManager : IDisposable
{
    private readonly NotifyIcon _notifyIcon;
    private readonly ToolStripMenuItem _showOrbItem;
    private readonly ToolStripMenuItem _orbShapeItem;
    private readonly ToolStripMenuItem _pillShapeItem;
    private readonly ToolStripMenuItem _followModeItem;
    private readonly ToolStripMenuItem _freeFloatModeItem;
    private readonly ToolStripMenuItem _startupItem;
    private Icon? _currentIcon;
    private bool _disposed;

    public event Action? OpenConsoleRequested;
    public event Action? ToggleOrbRequested;
    public event Action<FloatingWidgetShape>? WidgetShapeRequested;
    public event Action<OrbDockMode>? DockModeRequested;
    public event Action? ResetPositionRequested;
    public event Action<bool>? StartWithWindowsRequested;
    public event Action? ExitRequested;

    public TrayIconManager()
    {
        var menu = new ContextMenuStrip();

        var openItem = new ToolStripMenuItem("Open Management Console");
        openItem.Font = new Font(openItem.Font, FontStyle.Bold);
        openItem.Click += (_, _) => OpenConsoleRequested?.Invoke();

        _showOrbItem = new ToolStripMenuItem("Show Floating Widget") { CheckOnClick = false };
        _showOrbItem.Click += (_, _) => ToggleOrbRequested?.Invoke();

        var shapeMenu = new ToolStripMenuItem("Widget Shape");
        _orbShapeItem = new ToolStripMenuItem("Circular Dual-Ring Orb");
        _orbShapeItem.Click += (_, _) => WidgetShapeRequested?.Invoke(FloatingWidgetShape.CircularOrb);
        _pillShapeItem = new ToolStripMenuItem("Compact 3-Metric Pill");
        _pillShapeItem.Click += (_, _) => WidgetShapeRequested?.Invoke(FloatingWidgetShape.CompactPill);
        shapeMenu.DropDownItems.Add(_orbShapeItem);
        shapeMenu.DropDownItems.Add(_pillShapeItem);

        var modeMenu = new ToolStripMenuItem("Dock Mode");
        _followModeItem = new ToolStripMenuItem("Follow Antigravity Window");
        _followModeItem.Click += (_, _) => DockModeRequested?.Invoke(OrbDockMode.FollowAntigravity);
        _freeFloatModeItem = new ToolStripMenuItem("Always-On-Top Free Float");
        _freeFloatModeItem.Click += (_, _) => DockModeRequested?.Invoke(OrbDockMode.FreeFloat);
        modeMenu.DropDownItems.Add(_followModeItem);
        modeMenu.DropDownItems.Add(_freeFloatModeItem);

        var resetPosItem = new ToolStripMenuItem("Reset Widget Position");
        resetPosItem.Click += (_, _) => ResetPositionRequested?.Invoke();

        _startupItem = new ToolStripMenuItem("Start with Windows");
        _startupItem.Click += (_, _) => StartWithWindowsRequested?.Invoke(!_startupItem.Checked);

        var exitItem = new ToolStripMenuItem("Exit UsageOrb");
        exitItem.Click += (_, _) => ExitRequested?.Invoke();

        menu.Items.Add(openItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(_showOrbItem);
        menu.Items.Add(shapeMenu);
        menu.Items.Add(modeMenu);
        menu.Items.Add(resetPosItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(_startupItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(exitItem);

        _currentIcon = AppIconFactory.CreateTrayIcon(
            0,
            100,
            Color.FromArgb(56, 189, 248),
            Color.FromArgb(52, 211, 153));
        _notifyIcon = new NotifyIcon
        {
            Icon = _currentIcon,
            Text = "Antigravity UsageOrb",
            ContextMenuStrip = menu,
            Visible = false,
        };

        _notifyIcon.MouseClick += (_, e) =>
        {
            if (e.Button == MouseButtons.Left)
            {
                OpenConsoleRequested?.Invoke();
            }
        };
    }

    internal void SetVisible(bool visible) => _notifyIcon.Visible = visible;

    public void UpdateState(AppSettings settings, DashboardSnapshot? snapshot, ResolvedDisplaySession? resolved = null)
    {
        if (_disposed) return;

        _showOrbItem.Checked = settings.OrbVisible;
        _orbShapeItem.Checked = settings.WidgetShape == FloatingWidgetShape.CircularOrb;
        _pillShapeItem.Checked = settings.WidgetShape == FloatingWidgetShape.CompactPill;
        _followModeItem.Checked = settings.DockMode == OrbDockMode.FollowAntigravity;
        _freeFloatModeItem.Checked = settings.DockMode == OrbDockMode.FreeFloat;
        _startupItem.Checked = settings.StartWithWindows;

        var activeSession = resolved?.Session ?? snapshot?.ActiveSession;
        double ctxPct = activeSession?.ContextUsedPercent ?? 0;
        var ctxColor = ctxPct >= settings.ContextCriticalPercent
            ? Color.FromArgb(248, 113, 113)
            : (ctxPct >= settings.ContextWarnPercent
                ? Color.FromArgb(251, 191, 36)
                : Color.FromArgb(56, 189, 248));

        QuotaWindowSummary? q5 = null;
        QuotaWindowSummary? q7 = null;
        if (snapshot is not null)
        {
            (q5, q7) = QuotaResolver.Resolve(snapshot, settings, session: activeSession);
        }

        var rem5h = q5?.RemainingPercent ?? 0;
        var quotaColor = rem5h <= Math.Min(15, settings.QuotaLowPercent)
            ? Color.FromArgb(248, 113, 113)
            : (rem5h <= Math.Max(40, settings.QuotaLowPercent)
                ? Color.FromArgb(251, 191, 36)
                : Color.FromArgb(52, 211, 153));

        var nextIcon = AppIconFactory.CreateTrayIcon(ctxPct, rem5h, ctxColor, quotaColor);
        var prevIcon = _currentIcon;
        _currentIcon = nextIcon;
        _notifyIcon.Icon = nextIcon;
        prevIcon?.Dispose();

        // NotifyIcon.Text is capped at 63 characters on Windows
        string tip = snapshot is not null
            ? $"UsageOrb · CTX {(activeSession is null ? "—" : $"{ctxPct:0}%")} · 5H {q5?.FormatPercent()} · WK {q7?.FormatPercent()}"
            : "Antigravity UsageOrb";
        if (tip.Length > 63) tip = tip[..63];
        _notifyIcon.Text = tip;
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _notifyIcon.Visible = false;
        _notifyIcon.Dispose();
        _currentIcon?.Dispose();
    }
}
