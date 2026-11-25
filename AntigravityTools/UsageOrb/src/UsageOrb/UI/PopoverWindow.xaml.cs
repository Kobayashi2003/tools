using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Threading;
using UsageOrb.Core;
using UsageOrb.Platform;

namespace UsageOrb.UI;

public partial class PopoverWindow : Window
{
    private sealed record SessionChoice(string? ConversationId, string Label)
    {
        public override string ToString() => Label;
    }

    private readonly DispatcherTimer _tickTimer;
    private DashboardSnapshot? _snapshot;
    private ResolvedDisplaySession? _displaySession;
    private AppSettings _settings = new();
    private string? _pinnedConversationId;
    private bool _suppressComboEvent;
    private DateTimeOffset _lastDeactivatedUtc = DateTimeOffset.MinValue;

    public event Action? ManageUsageRequested;
    public event Action? RefreshRequested;
    public event Action<string?>? SessionSelectionChanged;

    public bool WasJustDismissed => (DateTimeOffset.UtcNow - _lastDeactivatedUtc).TotalMilliseconds < 240;

    public PopoverWindow()
    {
        InitializeComponent();

        SourceInitialized += (_, _) =>
        {
            var hwnd = new WindowInteropHelper(this).Handle;
            NativeMethods.ApplyOverlayWindowStyles(hwnd, noActivate: false);
        };

        Deactivated += (_, _) =>
        {
            _lastDeactivatedUtc = DateTimeOffset.UtcNow;
            if (IsVisible) Hide();
        };

        PreviewKeyDown += (_, e) =>
        {
            if (e.Key == Key.Escape)
            {
                Hide();
                e.Handled = true;
            }
        };

        CloseBtn.Click += (_, _) => Hide();
        RefreshBtn.Click += (_, _) => RefreshRequested?.Invoke();
        ManageBtn.Click += (_, _) =>
        {
            Hide();
            ManageUsageRequested?.Invoke();
        };
        CopyBtn.Click += OnCopyClicked;
        SessionCombo.SelectionChanged += OnSessionComboChanged;

        _tickTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
        _tickTimer.Tick += (_, _) =>
        {
            if (IsVisible && _snapshot is not null)
            {
                RenderQuotaRows(_snapshot, _settings);
            }
        };
        _tickTimer.Start();
    }

    public void UpdateData(
        DashboardSnapshot? snapshot,
        AppSettings settings,
        ResolvedDisplaySession? displaySession = null,
        string? pinnedConversationId = null)
    {
        _snapshot = snapshot;
        _settings = settings.Clone();
        _displaySession = displaySession;
        _pinnedConversationId = pinnedConversationId;
        RenderAll();
    }

    public void ShowNear(Window orb)
    {
        RenderAll();
        if (!IsVisible)
        {
            Show();
        }

        UpdateLayout();
        ScreenPlacementHelper.PlaceNearOrb(this, orb, gapDip: 10);
        Activate();
    }

    private SessionDetail? ResolveSelectedSession()
    {
        if (_snapshot is null) return null;
        if (!string.IsNullOrEmpty(_pinnedConversationId))
        {
            var match = _snapshot.Sessions.FirstOrDefault(s =>
                string.Equals(s.ConversationId, _pinnedConversationId, StringComparison.OrdinalIgnoreCase));
            if (match is not null) return match;
        }

        return _displaySession?.Session ?? _snapshot.ActiveSession;
    }

    private void RenderAll()
    {
        if (_snapshot is null) return;

        // Plan pill
        if (!string.IsNullOrWhiteSpace(_snapshot.PlanTier))
        {
            PlanPill.Visibility = Visibility.Visible;
            PlanPillText.Text = _snapshot.PlanTier;
        }
        else
        {
            PlanPill.Visibility = Visibility.Collapsed;
        }

        PopulateSessionCombo(_snapshot);

        var s = ResolveSelectedSession();

        // Compact alert banner for critical/warning states only
        var topAlert = _snapshot.Insights.FirstOrDefault(i => i.Severity is "critical" or "warning");
        if (topAlert is not null)
        {
            AlertBanner.Visibility = Visibility.Visible;
            bool isCrit = topAlert.Severity == "critical";
            AlertBanner.Background = TryFindResource(isCrit ? "DangerBgBrush" : "WarnBgBrush") as System.Windows.Media.Brush;
            AlertBanner.BorderBrush = TryFindResource(isCrit ? "DangerBrush" : "WarnBrush") as System.Windows.Media.Brush;
            AlertTitle.Text = topAlert.Title;
            AlertBody.Text = topAlert.Recommendation ?? topAlert.Detail;
        }
        else
        {
            AlertBanner.Visibility = Visibility.Collapsed;
        }

        // 1. Context Window
        if (s is not null)
        {
            Over200kBadge.Visibility = s.Exceeds200kTokens ? Visibility.Visible : Visibility.Collapsed;
            ContextPctText.Text = $"{s.ContextUsedPercent:F1}%";
            ContextPctText.Foreground = s.ContextUsedPercent >= _settings.ContextWarnPercent
                ? ScreenPlacementHelper.BrushForContext(s.ContextUsedPercent, _settings.ContextWarnPercent, _settings.ContextCriticalPercent, this)
                : (TryFindResource("FgPrimaryBrush") as System.Windows.Media.Brush ?? System.Windows.Media.Brushes.White);

            ContextSubText.Text = $"{FormatUtil.TokensCompact(s.CurrentContextTokens)} / {FormatUtil.TokensCompact(s.ContextWindowSize)} · {FormatUtil.TokensCompact(s.ContextRemainingTokens)} free";
            ModelTagText.Text = $"{s.PrimaryModelDisplayName}";
            RenderStackedBar(s);

            CacheHitMetric.Text = $"{s.OverallCacheHitRate * 100:F1}%";
            CacheHitMetric.Foreground = TryFindResource(
                s.OverallCacheHitRate >= 0.7 ? "FgPrimaryBrush" : (s.OverallCacheHitRate >= 0.45 ? "WarnBrush" : "DangerBrush")) as System.Windows.Media.Brush;

            string sign = s.LastContextDelta >= 0 ? "+" : "";
            LastDeltaMetric.Text = $"{sign}{FormatUtil.TokensCompact(s.LastContextDelta)}";
            CompactionsMetric.Text = s.CompactionCount.ToString();
        }
        else
        {
            Over200kBadge.Visibility = Visibility.Collapsed;
            ContextPctText.Text = "—";
            ContextSubText.Text = "No matching conversation";
            ModelTagText.Text = "";
            StackedBarGrid.Children.Clear();
            CacheHitMetric.Text = "—";
            LastDeltaMetric.Text = "—";
            CompactionsMetric.Text = "0";
        }

        // 2 & 3. 5-Hour & Weekly Remaining
        RenderQuotaRows(_snapshot, _settings);
    }

    private void RenderQuotaRows(DashboardSnapshot snap, AppSettings settings)
    {
        var (q5, q7) = QuotaResolver.Resolve(snap, settings, DateTimeOffset.UtcNow, ResolveSelectedSession());

        // 5-Hour
        var b5 = ScreenPlacementHelper.BrushForRemaining(q5.RemainingPercent, settings.QuotaLowPercent, this);
        FiveHourBadge.Background = TryFindResource(q5.IsLive ? "OkBgBrush" : "BgTertiaryBrush") as System.Windows.Media.Brush;
        FiveHourBadgeText.Foreground = TryFindResource(q5.IsLive ? "OkBrush" : "FgMutedBrush") as System.Windows.Media.Brush;
        FiveHourBadgeText.Text = q5.StatusBadge;
        FiveHourPctText.Text = q5.FormatPercent();
        FiveHourPctText.Foreground = b5;
        FillBar(FiveHourBarGrid, q5.RemainingPercent ?? 0, b5);
        FiveHourSubText.Text = q5.IsLive
            ? $"{(q5.ResetInSeconds.HasValue ? $"Resets in {FormatUtil.Duration(q5.ResetInSeconds)}" : "Live quota")} · {FormatUtil.Tokens(q5.WindowTokens)} tok"
            : q5.RemainingPercent is null ? $"{FormatUtil.Tokens(q5.WindowTokens)} local tok"
            : $"{FormatUtil.Tokens(q5.WindowTokens)} / {FormatUtil.TokensCompact(q5.EstimatedBaselineTokens)} est. · {FormatUtil.Tokens(q5.TokensPerHour)}/h";

        // Weekly
        var b7 = ScreenPlacementHelper.BrushForRemaining(q7.RemainingPercent, settings.QuotaLowPercent, this);
        WeeklyBadge.Background = TryFindResource(q7.IsLive
            ? (q7.WillExhaustBeforeReset == true ? "DangerBgBrush" : "OkBgBrush")
            : "BgTertiaryBrush") as System.Windows.Media.Brush;
        WeeklyBadgeText.Foreground = TryFindResource(q7.IsLive
            ? (q7.WillExhaustBeforeReset == true ? "DangerBrush" : "OkBrush")
            : "FgMutedBrush") as System.Windows.Media.Brush;
        WeeklyBadgeText.Text = q7.StatusBadge;
        WeeklyPctText.Text = q7.FormatPercent();
        WeeklyPctText.Foreground = b7;
        FillBar(WeeklyBarGrid, q7.RemainingPercent ?? 0, b7);

        string paceStatus = q7.WillExhaustBeforeReset == true ? "At risk" : (q7.WillExhaustBeforeReset == false ? "Safe" : $"{q7.SessionsCount} chats");
        WeeklySubText.Text = q7.IsLive
            ? $"{(q7.ResetInSeconds.HasValue ? $"Resets in {FormatUtil.Duration(q7.ResetInSeconds)}" : "Live quota")} · {paceStatus}"
            : q7.RemainingPercent is null ? $"{FormatUtil.Tokens(q7.WindowTokens)} local tok"
            : $"{FormatUtil.Tokens(q7.WindowTokens)} / {FormatUtil.TokensCompact(q7.EstimatedBaselineTokens)} est. · {q7.SessionsCount} chats";
    }

    private void PopulateSessionCombo(DashboardSnapshot snap)
    {
        _suppressComboEvent = true;
        try
        {
            var selectedSession = ResolveSelectedSession();
            var resolvedHint = _displaySession is { Source: SessionBindSource.WindowTitleMatch or SessionBindSource.WorkspaceMatch, Session: not null }
                ? $"Auto ({_displaySession.SourceLabel}) · {(_displaySession.Session.Title.Length > 20 ? _displaySession.Session.Title[..17] + "..." : _displaySession.Session.Title)}"
                : "Auto · Current Conversation";
            var choices = new List<SessionChoice> { new(null, resolvedHint) };
            foreach (var s in snap.Sessions.Where(x => !x.IsSubagent).Take(12))
            {
                string star = s.ConversationId == selectedSession?.ConversationId ? "★ " : "";
                string shortTitle = s.Title.Length > 34 ? s.Title[..31] + "..." : s.Title;
                choices.Add(new SessionChoice(s.ConversationId, $"{star}{shortTitle} ({s.ContextUsedPercent:0}%)"));
            }

            SessionCombo.ItemsSource = choices;
            var selected = choices.FirstOrDefault(c => string.Equals(c.ConversationId, _pinnedConversationId, StringComparison.OrdinalIgnoreCase))
                           ?? choices[0];
            SessionCombo.SelectedItem = selected;
        }
        finally
        {
            _suppressComboEvent = false;
        }
    }

    private void RenderStackedBar(SessionDetail s)
    {
        StackedBarGrid.Children.Clear();
        StackedBarGrid.ColumnDefinitions.Clear();

        var nonZero = s.Categories.Where(c => c.Tokens > 0).ToList();
        var brushConv = new BrushConverter();

        int col = 0;
        foreach (var cat in nonZero)
        {
            double pct = Math.Max(0.4, cat.PercentageOfWindow);
            StackedBarGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(pct, GridUnitType.Star) });
            var brush = (System.Windows.Media.Brush)brushConv.ConvertFromString(cat.ColorHex)!;
            var seg = new Border
            {
                Background = brush,
                Margin = new Thickness(0, 0, 1, 0),
                ToolTip = $"{cat.Label}: {FormatUtil.Tokens(cat.Tokens)} ({cat.PercentageOfContext:F1}%)",
            };
            Grid.SetColumn(seg, col++);
            StackedBarGrid.Children.Add(seg);
        }

        double freePct = Math.Max(0, 100.0 - nonZero.Sum(c => c.PercentageOfWindow));
        if (freePct > 0.2)
        {
            StackedBarGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(freePct, GridUnitType.Star) });
        }
    }

    private static void FillBar(Grid host, double pct, System.Windows.Media.Brush fill)
    {
        host.Children.Clear();
        host.ColumnDefinitions.Clear();
        double clamped = Math.Clamp(pct, 0, 100);
        if (clamped <= 0.1) return;

        host.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(Math.Max(1.0, clamped), GridUnitType.Star) });
        if (clamped < 99.8)
        {
            host.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(Math.Max(0.2, 100.0 - clamped), GridUnitType.Star) });
        }

        host.Children.Add(new Border
        {
            Background = fill,
            CornerRadius = new CornerRadius(3),
        });
    }

    private void OnSessionComboChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_suppressComboEvent) return;
        if (SessionCombo.SelectedItem is SessionChoice choice)
        {
            _pinnedConversationId = choice.ConversationId;
            SessionSelectionChanged?.Invoke(choice.ConversationId);
            RenderAll();
        }
    }

    private void OnCopyClicked(object sender, RoutedEventArgs e)
    {
        if (_snapshot is null) return;
        var s = ResolveSelectedSession();
        var (q5, q7) = QuotaResolver.Resolve(_snapshot, _settings, session: s);

        var lines = new List<string>
        {
            $"Antigravity Telemetry ({_snapshot.GeneratedAt.ToLocalTime():yyyy-MM-dd HH:mm:ss})",
            $"5-Hour Remaining ({q5.StatusBadge}): {q5.FormatPercent("F1")} · {FormatUtil.Tokens(q5.WindowTokens)} tok ({FormatUtil.Tokens(q5.TokensPerHour)}/h)",
            $"Weekly Remaining ({q7.StatusBadge}): {q7.FormatPercent("F1")} · {FormatUtil.Tokens(q7.WindowTokens)} tok ({q7.SessionsCount} chats)",
        };

        if (s is not null)
        {
            lines.Add($"Context ({s.PrimaryModelDisplayName}): {FormatUtil.Exact(s.CurrentContextTokens)} / {FormatUtil.Exact(s.ContextWindowSize)} ({s.ContextUsedPercent:F1}%), Cache {s.OverallCacheHitRate * 100:F1}%, Compactions {s.CompactionCount}");
        }

        try
        {
            System.Windows.Clipboard.SetText(string.Join(Environment.NewLine, lines));
            CopyBtnText.Text = "Copied!";
            var resetTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(1600) };
            resetTimer.Tick += (_, _) =>
            {
                resetTimer.Stop();
                CopyBtnText.Text = "Copy";
            };
            resetTimer.Start();
        }
        catch
        {
            // Ignore transient clipboard lock
        }
    }
}
