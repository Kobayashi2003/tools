using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Shapes;
using System.Windows.Threading;
using UsageOrb.Core;
using UsageOrb.Platform;

namespace UsageOrb.UI;

public partial class ManagementWindow : Window
{
    private sealed record SessionPickerItem(string? ConversationId, string Label)
    {
        public override string ToString() => Label;
    }

    public sealed record SessionGridRow(
        int Rank,
        string ConversationId,
        string Title,
        string Surface,
        string Model,
        string Context,
        string UsedPct,
        System.Windows.Media.Brush UsedBg,
        System.Windows.Media.Brush UsedFg,
        string Total,
        string Cache,
        string Compactions,
        string Cost,
        string LastActive);

    private readonly DispatcherTimer _countdownTimer;
    private DashboardSnapshot? _snapshot;
    private ResolvedDisplaySession? _displaySession;
    private string? _pinnedConversationId;
    private AppSettings _settings;
    private WindowKey _selectedWindow = WindowKey.SevenDays;
    private string? _inspectedConversationId;
    private string _selectedStepKindFilter = "ALL";
    private int _selectedTabIndex;
    private bool _isDark = true;
    private bool _suppressUiEvents;

    // Pending draft choices in Settings panel (until Save Preferences is clicked)
    private FloatingWidgetShape _draftShape;
    private OrbAnchorCorner _draftAnchor;
    private int _draftOrbSize;
    private ThemePreference _draftTheme;

    public event Action<AppSettings>? SettingsSaved;
    public event Action? ResetPositionRequested;
    public event Action<bool>? RefreshRequested;
    public event Action<string?>? SessionPinRequested;

    public ManagementWindow(AppSettings initialSettings)
    {
        InitializeComponent();
        _settings = initialSettings.Clone();
        _draftShape = _settings.WidgetShape;
        _draftAnchor = _settings.AnchorCorner;
        _draftOrbSize = _settings.OrbSizePx;
        _draftTheme = _settings.Theme;

        Icon = AppIconFactory.CreateWindowIcon();

        SourceInitialized += (_, _) =>
        {
            var hwnd = new WindowInteropHelper(this).Handle;
            NativeMethods.ApplyWindowDwmPolish(hwnd, _isDark);
        };

        StateChanged += (_, _) =>
        {
            RootFrame.Margin = WindowState == WindowState.Maximized ? new Thickness(7) : new Thickness(0);
            RootFrame.CornerRadius = WindowState == WindowState.Maximized ? new CornerRadius(0) : new CornerRadius(10);
        };

        Closing += (_, e) =>
        {
            // Keep running in system tray when user closes the management console
            e.Cancel = true;
            Hide();
        };

        MinimizeWinBtn.Click += (_, _) => WindowState = WindowState.Minimized;
        MaximizeWinBtn.Click += (_, _) => WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;
        CloseWinBtn.Click += (_, _) => Hide();

        HeroCtxCard.MouseLeftButtonUp += (_, _) =>
        {
            _inspectedConversationId = null;
            if (_snapshot is not null) RenderContextTab(_snapshot);
            SelectTab(1);
        };
        PinSessionBtn.Click += OnPinSessionClicked;
        InlineCliLinkBtn.Click += (_, _) => SelectTab(3);
        RefreshBtn.Click += (_, _) => RefreshRequested?.Invoke(false);
        RefreshModelsBtn.Click += (_, _) => RefreshRequested?.Invoke(true);
        InspectorSessionCombo.SelectionChanged += OnInspectorSessionChanged;
        StepFilterBox.TextChanged += (_, _) => RenderStepTable();
        SessionSearchBox.TextChanged += (_, _) => RenderSessionsTable();
        ShowSubagentsCheck.Checked += (_, _) => RenderSessionsTable();
        ShowSubagentsCheck.Unchecked += (_, _) => RenderSessionsTable();
        SessionsGrid.MouseDoubleClick += OnSessionsGridDoubleClick;
        OpacitySlider.ValueChanged += (_, _) => OpacityLabel.Text = $"{(int)Math.Round(OpacitySlider.Value * 100)}%";
        SaveSettingsBtn.Click += OnSaveSettingsClicked;
        ResetPosBtn.Click += (_, _) => ResetPositionRequested?.Invoke();
        AutoConfigCliBtn.Click += OnAutoConfigureCliClicked;
        CopyStatusLineCmdBtn.Click += OnCopyStatusLineCommand;

        BuildNavTabs();
        BuildWindowPills();
        BuildStepKindPills();
        PopulateSettingsControls();
        UpdateCliCommandText();

        _countdownTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
        _countdownTimer.Tick += (_, _) =>
        {
            if (IsVisible && _selectedTabIndex == 0 && _snapshot is not null)
            {
                RenderHeroCards(_snapshot);
                if (_snapshot.QuotaBuckets.Count > 0)
                {
                    RenderLiveQuotaBuckets(_snapshot);
                }
            }
        };
        _countdownTimer.Start();
    }

    public void UpdateTheme(bool isDark)
    {
        _isDark = isDark;
        var hwnd = new WindowInteropHelper(this).Handle;
        if (hwnd != IntPtr.Zero)
        {
            NativeMethods.ApplyWindowDwmPolish(hwnd, isDark);
        }

        BuildNavTabs();
        BuildWindowPills();
        BuildStepKindPills();
        RebuildSettingsSegments();
        if (_snapshot is not null) RenderAll();
    }

    public void UpdateSettings(AppSettings settings)
    {
        _settings = settings.Clone();
        PopulateSettingsControls();
        if (_snapshot is not null) RenderAll();
    }

    public void UpdateSnapshot(
        DashboardSnapshot snapshot,
        ResolvedDisplaySession? displaySession = null,
        string? pinnedConversationId = null)
    {
        _snapshot = snapshot;
        _displaySession = displaySession;
        _pinnedConversationId = pinnedConversationId;
        RenderAll();
    }

    private void SelectTab(int index)
    {
        _selectedTabIndex = Math.Clamp(index, 0, 3);
        TabOverviewView.Visibility = _selectedTabIndex == 0 ? Visibility.Visible : Visibility.Collapsed;
        TabContextView.Visibility = _selectedTabIndex == 1 ? Visibility.Visible : Visibility.Collapsed;
        TabModelsView.Visibility = _selectedTabIndex == 2 ? Visibility.Visible : Visibility.Collapsed;
        TabSessionsView.Visibility = _selectedTabIndex == 3 ? Visibility.Visible : Visibility.Collapsed;
        BuildNavTabs();
    }

    private void BuildNavTabs()
    {
        NavTabBar.Children.Clear();
        string[] labels = ["Overview & Quotas", "Context Inspector", "Models & Tools", "Sessions & Settings"];
        for (int i = 0; i < labels.Length; i++)
        {
            bool active = i == _selectedTabIndex;
            int idx = i;
            var btn = CreateSegmentButton(labels[i], active, padding: new Thickness(15, 6, 15, 6), fontSize: 12.5);
            btn.Click += (_, _) => SelectTab(idx);
            NavTabBar.Children.Add(btn);
        }
    }

    private void BuildWindowPills()
    {
        void BuildInto(System.Windows.Controls.Panel panel)
        {
            panel.Children.Clear();
            foreach (WindowKey key in new[] { WindowKey.FiveHours, WindowKey.TwentyFourHours, WindowKey.SevenDays, WindowKey.ThirtyDays, WindowKey.All })
            {
                bool active = key == _selectedWindow;
                var captured = key;
                var btn = CreateSegmentButton(FormatUtil.WindowShort(key), active, padding: new Thickness(10, 4, 10, 4), fontSize: 11);
                btn.Click += (_, _) =>
                {
                    _selectedWindow = captured;
                    BuildWindowPills();
                    if (_snapshot is not null) RenderAll();
                };
                panel.Children.Add(btn);
            }
        }

        BuildInto(WindowPillsPanel);
        BuildInto(ModelsWindowPills);
    }

    private void BuildStepKindPills()
    {
        StepKindPillsHost.Children.Clear();
        (string Key, string Label)[] options =
        [
            ("ALL", "All"),
            ("LLM", "LLM"),
            ("TOOLS", "Tools"),
            ("CHECKPOINT", "Checkpoints"),
        ];
        foreach (var (key, label) in options)
        {
            bool active = string.Equals(_selectedStepKindFilter, key, StringComparison.OrdinalIgnoreCase);
            var captured = key;
            var btn = CreateSegmentButton(label, active, padding: new Thickness(9, 4, 9, 4), fontSize: 11);
            btn.Click += (_, _) =>
            {
                _selectedStepKindFilter = captured;
                BuildStepKindPills();
                RenderStepTable();
            };
            StepKindPillsHost.Children.Add(btn);
        }
    }

    private System.Windows.Controls.Button CreateSegmentButton(
        string text,
        bool active,
        Thickness padding,
        double fontSize = 11.5,
        bool accentActive = false)
    {
        var bg = active
            ? TryFindResource(accentActive ? "AccentBrush" : "BgTertiaryBrush") as System.Windows.Media.Brush
            : System.Windows.Media.Brushes.Transparent;
        var fg = active
            ? (accentActive ? System.Windows.Media.Brushes.White : TryFindResource("FgPrimaryBrush") as System.Windows.Media.Brush)
            : TryFindResource("FgSecondaryBrush") as System.Windows.Media.Brush;

        var btn = new System.Windows.Controls.Button
        {
            Content = text,
            Padding = padding,
            FontSize = fontSize,
            FontWeight = active ? FontWeights.SemiBold : FontWeights.Normal,
            Foreground = fg,
            Background = bg,
            BorderThickness = new Thickness(0),
            Cursor = System.Windows.Input.Cursors.Hand,
        };

        // Crisp rounded template without default WPF chrome
        var bdFactory = new FrameworkElementFactory(typeof(Border));
        bdFactory.SetValue(Border.CornerRadiusProperty, new CornerRadius(7));
        bdFactory.SetBinding(Border.BackgroundProperty, new System.Windows.Data.Binding("Background") { RelativeSource = new System.Windows.Data.RelativeSource(System.Windows.Data.RelativeSourceMode.TemplatedParent) });
        bdFactory.SetBinding(Border.PaddingProperty, new System.Windows.Data.Binding("Padding") { RelativeSource = new System.Windows.Data.RelativeSource(System.Windows.Data.RelativeSourceMode.TemplatedParent) });

        var cpFactory = new FrameworkElementFactory(typeof(ContentPresenter));
        cpFactory.SetValue(HorizontalAlignmentProperty, System.Windows.HorizontalAlignment.Center);
        cpFactory.SetValue(VerticalAlignmentProperty, VerticalAlignment.Center);
        bdFactory.AppendChild(cpFactory);

        btn.Template = new ControlTemplate(typeof(System.Windows.Controls.Button)) { VisualTree = bdFactory };
        return btn;
    }

    private void ShowToast(string message)
    {
        StatusToast.Text = message;
        var timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(3.0) };
        timer.Tick += (_, _) =>
        {
            timer.Stop();
            if (StatusToast.Text == message) StatusToast.Text = "";
        };
        timer.Start();
    }

    private void RenderAll()
    {
        if (_snapshot is null) return;

        // Title bar metadata
        if (!string.IsNullOrWhiteSpace(_snapshot.PlanTier))
        {
            PlanChip.Visibility = Visibility.Visible;
            PlanChipText.Text = _snapshot.PlanTier;
        }
        else
        {
            PlanChip.Visibility = Visibility.Collapsed;
        }

        var parts = new List<string>
        {
            $"{_snapshot.Sessions.Count} sessions",
            $"Updated {_snapshot.GeneratedAt.ToLocalTime():HH:mm:ss}",
        };
        if (!string.IsNullOrWhiteSpace(_snapshot.AccountEmail)) parts.Insert(0, _snapshot.AccountEmail);
        HeaderSubtitle.Text = string.Join(" · ", parts);

        RenderOverviewTab(_snapshot);
        RenderContextTab(_snapshot);
        RenderModelsTab(_snapshot);
        RenderSessionsTable();
        RenderCliSyncStatus(_snapshot);
    }

    // =========================================================================
    // TAB 1: OVERVIEW & QUOTAS
    // =========================================================================
    private void RenderOverviewTab(DashboardSnapshot snap)
    {
        var win = snap.Windows[_selectedWindow];
        var w5 = snap.Windows[WindowKey.FiveHours];
        var w7 = snap.Windows[WindowKey.SevenDays];

        RenderHeroCards(snap);

        // Row 2: Slim Secondary Metric Strip
        StripCacheVal.Text = $"{win.CacheHitRate * 100:F1}% (Saved ~{FormatUtil.Usd(win.CacheSavedUsd)})";
        StripPaceVal.Text = snap.SprintVsWeeklyPaceRatio is > 0
            ? $"{snap.SprintVsWeeklyPaceRatio:F1}× weekly avg"
            : "Baseline collecting";
        StripSpendVal.Text = $"{FormatUtil.Usd(w5.EstimatedCostUsd)} (5h) · {FormatUtil.Usd(w7.EstimatedCostUsd)} (7d)";

        if (snap.DesktopQuotaLastSeenAt is { } desktopRead)
        {
            InlineCliLinkText.Text = $"Desktop quota · {FormatUtil.RelativeTime(desktopRead)}";
            InlineCliLinkText.Foreground = TryFindResource("OkBrush") as System.Windows.Media.Brush;
        }
        else if (snap.StatusLineConnected && snap.StatusLineLastSeenAt.HasValue && snap.QuotaBuckets.Count > 0)
        {
            InlineCliLinkText.Text = $"CLI Live synced {FormatUtil.RelativeTime(snap.StatusLineLastSeenAt.Value)}";
            InlineCliLinkText.Foreground = TryFindResource("OkBrush") as System.Windows.Media.Brush;
        }
        else
        {
            InlineCliLinkText.Text = "Waiting for Antigravity App quota";
            InlineCliLinkText.Foreground = TryFindResource("AccentBrush") as System.Windows.Media.Brush;
        }

        RenderLiveQuotaBuckets(snap);

        var groupIds = w5.ByQuotaGroup.Select(g => g.GroupId)
            .Concat(w7.ByQuotaGroup.Select(g => g.GroupId))
            .Distinct()
            .ToList();
        var map5 = w5.ByQuotaGroup.ToDictionary(g => g.GroupId);
        var map7 = w7.ByQuotaGroup.ToDictionary(g => g.GroupId);

        QuotaMatrixGrid.ItemsSource = groupIds.Select(gid =>
        {
            map5.TryGetValue(gid, out var g5);
            map7.TryGetValue(gid, out var g7);
            return new
            {
                GroupLabel = g7?.Label ?? g5?.Label ?? gid.ToString(),
                FiveHourVolume = $"{FormatUtil.TokensCompact(g5?.TotalTokens ?? 0)} ({(g5?.ShareOfTokens ?? 0) * 100:0}%)",
                FiveHourRate = $"{FormatUtil.TokensCompact(g5?.BurnRateTokensPerHour ?? 0)}/h · {g5?.Invocations ?? 0} calls",
                SevenDayVolume = $"{FormatUtil.TokensCompact(g7?.TotalTokens ?? 0)} ({(g7?.ShareOfTokens ?? 0) * 100:0}%)",
                CacheHit = $"{(g7?.CacheHitRate ?? g5?.CacheHitRate ?? 0) * 100:F1}%",
                RefCost = FormatUtil.Usd(g7?.EstimatedCostUsd ?? 0),
            };
        }).ToList();

        // Row 4: Burn-Rate Timeline
        TimelineTitle.Text = "Token Burn-Rate Timeline";
        TimelineSubtitle.Text = $"{win.Label} · {FormatUtil.Tokens(win.TotalTokens)} total · {FormatUtil.Tokens(win.BurnRateTokensPerHour)}/h avg · {win.Invocations} calls";
        BurnRateChart.Update(win.Timeline);

        // Below-Fold: Quota History
        if (snap.QuotaHistory.Count >= 2)
        {
            QuotaHistoryCard.Visibility = Visibility.Visible;
            QuotaHistoryCanvas.Update(snap.QuotaHistory);
        }
        else
        {
            QuotaHistoryCard.Visibility = Visibility.Collapsed;
        }

        // Below-Fold: Diagnostics
        InsightsHost.Children.Clear();
        var fgPrimary = TryFindResource("FgPrimaryBrush") as System.Windows.Media.Brush ?? System.Windows.Media.Brushes.White;
        var fgSec = TryFindResource("FgSecondaryBrush") as System.Windows.Media.Brush ?? System.Windows.Media.Brushes.LightGray;
        var accent = TryFindResource("AccentBrush") as System.Windows.Media.Brush ?? System.Windows.Media.Brushes.CornflowerBlue;

        var insightsToShow = snap.Insights.Take(5).ToList();
        InsightsCard.Visibility = insightsToShow.Count > 0 ? Visibility.Visible : Visibility.Collapsed;

        foreach (var ins in insightsToShow)
        {
            string borderKey = ins.Severity == "critical" ? "DangerBrush" : (ins.Severity == "warning" ? "WarnBrush" : "CyanBrush");
            var card = new Border
            {
                Background = TryFindResource("BgPrimaryBrush") as System.Windows.Media.Brush,
                BorderBrush = TryFindResource(borderKey) as System.Windows.Media.Brush,
                BorderThickness = new Thickness(3, 0, 0, 0),
                CornerRadius = new CornerRadius(7),
                Padding = new Thickness(12, 8, 12, 8),
                Margin = new Thickness(0, 0, 0, 6),
            };
            var stack = new StackPanel();
            stack.Children.Add(new TextBlock { Text = ins.Title, FontWeight = FontWeights.SemiBold, FontSize = 12, Foreground = fgPrimary });
            stack.Children.Add(new TextBlock { Text = ins.Detail, FontSize = 11.5, Foreground = fgSec, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 2, 0, 0) });
            if (!string.IsNullOrEmpty(ins.Recommendation))
            {
                stack.Children.Add(new TextBlock { Text = $"Tip: {ins.Recommendation}", FontSize = 11, Foreground = accent, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 3, 0, 0) });
            }

            card.Child = stack;
            InsightsHost.Children.Add(card);
        }
    }

    private void RenderHeroCards(DashboardSnapshot snap)
    {
        var now = DateTimeOffset.UtcNow;
        var active = _displaySession?.Session ?? snap.ActiveSession;
        var (q5, q7) = QuotaResolver.Resolve(snap, _settings, now, active);

        // Card 1: Active Context
        if (active is not null)
        {
            string bindTag = _displaySession?.Source == SessionBindSource.ManualPin
                ? "Pinned"
                : FormatUtil.SurfaceTag(active.Surface);
            HeroCtxModelPill.Text = $"{active.PrimaryModelDisplayName} · {bindTag}";
            HeroCtxCard.ToolTip = active.Title;
            HeroCtxPct.Text = $"{active.ContextUsedPercent:F1}%";
            HeroCtxPct.Foreground = active.ContextUsedPercent >= _settings.ContextWarnPercent
                ? ScreenPlacementHelper.BrushForContext(active.ContextUsedPercent, _settings.ContextWarnPercent, _settings.ContextCriticalPercent, this)
                : (TryFindResource("FgPrimaryBrush") as System.Windows.Media.Brush ?? System.Windows.Media.Brushes.White);
            RenderStackedBarInto(HeroCtxBar, active);
            HeroCtxSub.Text = $"{FormatUtil.TokensCompact(active.CurrentContextTokens)} / {FormatUtil.TokensCompact(active.ContextWindowSize)} tokens · {FormatUtil.TokensCompact(active.ContextRemainingTokens)} free";
        }
        else
        {
            HeroCtxModelPill.Text = "No active chat";
            HeroCtxCard.ToolTip = null;
            HeroCtxPct.Text = "—";
            HeroCtxPct.Foreground = TryFindResource("FgMutedBrush") as System.Windows.Media.Brush;
            HeroCtxBar.Children.Clear();
            HeroCtxSub.Text = "Start a conversation in Antigravity";
        }

        // Card 2: 5-Hour Quota Remaining
        var (bg5, bd5) = ScreenPlacementHelper.HeroTintForRemaining(q5.RemainingPercent, _settings.QuotaLowPercent, this);
        var fg5 = ScreenPlacementHelper.BrushForRemaining(q5.RemainingPercent, _settings.QuotaLowPercent, this);
        Hero5hCard.Background = bg5;
        Hero5hCard.BorderBrush = bd5;
        Hero5hBadge.Background = TryFindResource(q5.IsLive ? "OkBgBrush" : "BgTertiaryBrush") as System.Windows.Media.Brush;
        Hero5hBadgeText.Foreground = TryFindResource(q5.IsLive ? "OkBrush" : "FgSecondaryBrush") as System.Windows.Media.Brush;
        Hero5hBadgeText.Text = q5.StatusBadge;
        Hero5hCard.ToolTip = q5.BucketLabel;
        Hero5hPct.Text = q5.FormatPercent("F1");
        Hero5hPct.Foreground = fg5;
        FillProgressBar(Hero5hBar, q5.RemainingPercent ?? 0, fg5, cornerRadius: 3.5);
        Hero5hSub.Text = q5.IsLive
            ? $"{(q5.ResetInSeconds.HasValue ? $"↻ Resets in {FormatUtil.Duration(q5.ResetInSeconds)}" : "Live quota")} · {FormatUtil.TokensCompact(q5.WindowTokens)} tok · {FormatUtil.TokensCompact(q5.TokensPerHour)}/h"
            : q5.RemainingPercent is null ? $"{FormatUtil.TokensCompact(q5.WindowTokens)} local tok"
            : $"Est. vs {FormatUtil.TokensCompact(q5.EstimatedBaselineTokens)} · {FormatUtil.TokensCompact(q5.WindowTokens)} tok · {FormatUtil.TokensCompact(q5.TokensPerHour)}/h";

        // Card 3: Weekly Quota Remaining
        var (bg7, bd7) = ScreenPlacementHelper.HeroTintForRemaining(q7.RemainingPercent, _settings.QuotaLowPercent, this);
        var fg7 = ScreenPlacementHelper.BrushForRemaining(q7.RemainingPercent, _settings.QuotaLowPercent, this);
        HeroWkCard.Background = bg7;
        HeroWkCard.BorderBrush = bd7;
        HeroWkBadge.Background = TryFindResource(q7.IsLive
            ? (q7.WillExhaustBeforeReset == true ? "DangerBgBrush" : "OkBgBrush")
            : "BgTertiaryBrush") as System.Windows.Media.Brush;
        HeroWkBadgeText.Foreground = TryFindResource(q7.IsLive
            ? (q7.WillExhaustBeforeReset == true ? "DangerBrush" : "OkBrush")
            : "FgSecondaryBrush") as System.Windows.Media.Brush;
        HeroWkBadgeText.Text = q7.StatusBadge;
        HeroWkCard.ToolTip = q7.BucketLabel;
        HeroWkPct.Text = q7.FormatPercent("F1");
        HeroWkPct.Foreground = fg7;
        FillProgressBar(HeroWkBar, q7.RemainingPercent ?? 0, fg7, cornerRadius: 3.5);
        HeroWkSub.Text = q7.IsLive
            ? $"{(q7.ResetInSeconds.HasValue ? $"↻ Resets in {FormatUtil.Duration(q7.ResetInSeconds)}" : "Live quota")} · {FormatUtil.TokensCompact(q7.WindowTokens)} tok · {q7.SessionsCount} chats"
            : q7.RemainingPercent is null ? $"{FormatUtil.TokensCompact(q7.WindowTokens)} local tok"
            : $"Est. vs {FormatUtil.TokensCompact(q7.EstimatedBaselineTokens)} · {FormatUtil.TokensCompact(q7.WindowTokens)} tok · {q7.SessionsCount} chats";
    }

    private void RenderLiveQuotaBuckets(DashboardSnapshot snap)
    {
        LiveQuotaBucketsHost.Children.Clear();
        if (snap.QuotaBuckets.Count == 0)
        {
            LiveQuotaBucketsHost.Visibility = Visibility.Collapsed;
            return;
        }

        LiveQuotaBucketsHost.Visibility = Visibility.Visible;
        var now = DateTimeOffset.UtcNow;
        var fgPrimary = TryFindResource("FgPrimaryBrush") as System.Windows.Media.Brush ?? System.Windows.Media.Brushes.White;
        var fgMuted = TryFindResource("FgMutedBrush") as System.Windows.Media.Brush ?? System.Windows.Media.Brushes.Gray;
        var bg1 = TryFindResource("BgPrimaryBrush") as System.Windows.Media.Brush ?? System.Windows.Media.Brushes.Black;
        var border1 = TryFindResource("BorderSubtleBrush") as System.Windows.Media.Brush ?? System.Windows.Media.Brushes.DimGray;
        var track = TryFindResource("TrackBrush") as System.Windows.Media.Brush ?? System.Windows.Media.Brushes.DimGray;
        var accent = TryFindResource("AccentBrush") as System.Windows.Media.Brush ?? System.Windows.Media.Brushes.CornflowerBlue;

        foreach (var b in snap.QuotaBuckets)
        {
            var box = new Border
            {
                Background = bg1,
                BorderBrush = border1,
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(8),
                Padding = new Thickness(12, 8, 12, 8),
                Margin = new Thickness(0, 0, 0, 6),
            };

            if (b.RemainingFraction.HasValue)
            {
                double remPct = b.RemainingFraction.Value * 100.0;
                var fillBrush = ScreenPlacementHelper.BrushForRemaining(remPct, _settings.QuotaLowPercent, this);
                var resetSec = b.GetLiveResetInSeconds(now);

                var stack = new StackPanel();
                var top = new Grid { Margin = new Thickness(0, 0, 0, 5) };
                top.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                top.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

                var leftTitle = new StackPanel { Orientation = System.Windows.Controls.Orientation.Horizontal };
                leftTitle.Children.Add(new TextBlock { Text = b.Label, FontWeight = FontWeights.SemiBold, FontSize = 12, Foreground = fgPrimary });
                if (b.WillExhaustBeforeReset == true && b.ProjectedExhaustionTime.HasValue)
                {
                    leftTitle.Children.Add(MakeBadge($"0% at {b.ProjectedExhaustionTime.Value.ToLocalTime():HH:mm}", "DangerBgBrush", "DangerBrush"));
                }
                else if (b.WillExhaustBeforeReset == false)
                {
                    leftTitle.Children.Add(MakeBadge("Safe", "OkBgBrush", "OkBrush"));
                }

                top.Children.Add(leftTitle);

                var rightMeta = new TextBlock
                {
                    Text = $"{remPct:F1}% left" + (resetSec.HasValue ? $" · ↻ {FormatUtil.Duration(resetSec)}" : ""),
                    FontFamily = new System.Windows.Media.FontFamily("Consolas"),
                    FontWeight = FontWeights.Bold,
                    FontSize = 11.5,
                    Foreground = fillBrush,
                };
                Grid.SetColumn(rightMeta, 1);
                top.Children.Add(rightMeta);
                stack.Children.Add(top);

                var barHost = new Border { Height = 6, CornerRadius = new CornerRadius(3), Background = track, ClipToBounds = true };
                var barGrid = new Grid();
                FillProgressBar(barGrid, remPct, fillBrush, cornerRadius: 3);
                barHost.Child = barGrid;
                stack.Children.Add(barHost);

                box.Child = stack;
            }
            else if (b.RemainingAmount.HasValue)
            {
                var row = new Grid();
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                row.Children.Add(new TextBlock { Text = b.Label, FontWeight = FontWeights.SemiBold, FontSize = 12, Foreground = fgPrimary });
                var val = new TextBlock
                {
                    Text = $"{b.RemainingAmount.Value:0.##} credits",
                    FontFamily = new System.Windows.Media.FontFamily("Consolas"),
                    FontWeight = FontWeights.Bold,
                    FontSize = 12,
                    Foreground = accent,
                };
                Grid.SetColumn(val, 1);
                row.Children.Add(val);
                box.Child = row;
            }
            else
            {
                box.Child = new TextBlock { Text = b.Label, Foreground = fgMuted, FontSize = 11.5 };
            }

            LiveQuotaBucketsHost.Children.Add(box);
        }
    }

    // =========================================================================
    // TAB 2: CONTEXT INSPECTOR (Panel 3)
    // =========================================================================
    private void RenderContextTab(DashboardSnapshot snap)
    {
        var session = GetInspectedSession(snap);
        var active = _displaySession?.Session ?? snap.ActiveSession;
        var recentSessions = snap.Sessions.Take(80);
        if (session is not null && _inspectedConversationId is not null && !recentSessions.Contains(session))
        {
            recentSessions = recentSessions.Append(session);
        }

        _suppressUiEvents = true;
        try
        {
            var choices = recentSessions.Select(s =>
            {
                string prefix = s.ConversationId == active?.ConversationId ? "★ " : (s.IsSubagent ? "↳ " : "");
                string shortTitle = s.Title.Length > 48 ? s.Title[..45] + "..." : s.Title;
                return new SessionPickerItem(
                    s.ConversationId,
                    $"{prefix}[{FormatUtil.SurfaceTag(s.Surface)}] {shortTitle} ({FormatUtil.TokensCompact(s.CurrentContextTokens)} · {s.ContextUsedPercent:0}%)");
            }).Prepend(new SessionPickerItem(null, active is null ? "Auto · Current Conversation" : $"Auto · {active.Title}")).ToList();

            InspectorSessionCombo.ItemsSource = choices;
            var selChoice = choices.FirstOrDefault(c => string.Equals(c.ConversationId, _inspectedConversationId, StringComparison.OrdinalIgnoreCase))
                            ?? choices.FirstOrDefault();
            InspectorSessionCombo.SelectedItem = selChoice;
        }
        finally
        {
            _suppressUiEvents = false;
        }

        PinSessionBtn.IsEnabled = session is not null;
        InspectorBadgesPanel.Children.Clear();
        InspectorEmptyText.Visibility = session is null ? Visibility.Visible : Visibility.Collapsed;
        foreach (var panel in InspectorPanels.Children.OfType<FrameworkElement>().Skip(1))
        {
            panel.Visibility = session is null ? Visibility.Collapsed : Visibility.Visible;
        }
        InspectorSummary.Visibility = session is null ? Visibility.Collapsed : Visibility.Visible;
        if (session is null) return;

        UpdatePinButtonState(session.ConversationId);

        InspectorBadgesPanel.Children.Add(MakeBadge(session.PrimaryModelDisplayName, "PurpleBgBrush", "PurpleBrush", marginLeft: 0));
        InspectorBadgesPanel.Children.Add(MakeBadge(FormatUtil.SurfaceTag(session.Surface), "BgTertiaryBrush", "FgSecondaryBrush"));
        if (session.ConversationId == active?.ConversationId) InspectorBadgesPanel.Children.Add(MakeBadge("● Active", "OkBgBrush", "OkBrush"));
        if (session.IsSubagent) InspectorBadgesPanel.Children.Add(MakeBadge("Subagent", "PurpleBgBrush", "PurpleBrush"));
        if (session.Exceeds200kTokens) InspectorBadgesPanel.Children.Add(MakeBadge(">200K", "WarnBgBrush", "WarnBrush"));

        InspectorCtxNumbers.Text = $"{FormatUtil.Exact(session.CurrentContextTokens)} / {FormatUtil.Exact(session.ContextWindowSize)} tokens";
        InspectorCtxPct.Text = $"{session.ContextUsedPercent:F1}% used · {FormatUtil.TokensCompact(session.ContextRemainingTokens)} free";
        InspectorCtxPct.Foreground = session.ContextUsedPercent >= _settings.ContextWarnPercent
            ? ScreenPlacementHelper.BrushForContext(session.ContextUsedPercent, _settings.ContextWarnPercent, _settings.ContextCriticalPercent, this)
            : (TryFindResource("FgPrimaryBrush") as System.Windows.Media.Brush ?? System.Windows.Media.Brushes.White);

        RenderStackedBarInto(InspectorStackedBar, session);

        // 4 Pulse Tiles
        InspLatestTurn.Text = $"{FormatUtil.TokensCompact(session.LatestInputTokens)} + {FormatUtil.TokensCompact(session.LatestCacheReadTokens)} / {FormatUtil.TokensCompact(session.LatestOutputTokens)}";
        InspProjected.Text = $"Next ~{FormatUtil.TokensCompact(session.ProjectedNextContextTokens)}";
        InspCumulative.Text = $"{FormatUtil.Tokens(session.TotalBilledTokens)} tok";
        InspCumulativeSub.Text = $"In {FormatUtil.TokensCompact(session.TotalInputTokens)} · Cache {FormatUtil.TokensCompact(session.TotalCacheReadTokens)} · Out {FormatUtil.TokensCompact(session.TotalOutputTokens)}";
        InspPeakCache.Text = $"{FormatUtil.TokensCompact(session.PeakContextTokens)} · {session.OverallCacheHitRate * 100:F1}%";
        InspCounts.Text = $"{session.UserTurns} turns · {session.ModelInvocations} calls · {session.ToolCallCount} tools";
        InspCost.Text = FormatUtil.Usd(session.LiveCostUsd ?? session.RolledUpTotals.EstimatedCostUsd);
        InspCostSub.Text = session.Subagents.Count > 0 ? $"incl. {session.Subagents.Count} subagent(s)" : $"Primary {FormatUtil.Usd(session.EstimatedCostUsd)}";

        // 100-Cell Context Window Grid
        CellGridSubtitle.Text = $"Each cell = 1% of limit ({FormatUtil.TokensCompact(session.ContextWindowSize / 100.0)} tokens)";
        ContextCellGrid.Update(session.Categories, session.ContextWindowSize);
        if (session.CheckpointBufferTokens > 0)
        {
            CheckpointBufferText.Visibility = Visibility.Visible;
            CheckpointBufferText.Text = $"Checkpoint summary buffer: {FormatUtil.Exact(session.CheckpointBufferTokens)} tokens";
        }
        else
        {
            CheckpointBufferText.Visibility = Visibility.Collapsed;
        }

        // Active Category Breakdown (Panel 3 clean color-dot rows)
        RenderCategoryBreakdown(session);

        // Full-Width Growth Chart + Inline Compactions
        GrowthChart.Update(session);
        if (session.Compactions.Count > 0)
        {
            CompactionsSection.Visibility = Visibility.Visible;
            CompactionsHeader.Text = $"Compaction Checkpoints ({session.Compactions.Count})";
            CompactionsGrid.ItemsSource = session.Compactions.Select(cp => new
            {
                Step = $"#{cp.StepIndex}",
                Time = cp.CreatedAt.ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss"),
                Before = FormatUtil.Tokens(cp.BeforeTokens),
                Summary = FormatUtil.Tokens(cp.SummaryTokens),
                Freed = "-" + FormatUtil.Tokens(cp.FreedTokens),
                Ratio = $"{cp.CompressionRatio * 100:F1}%",
            }).ToList();
        }
        else
        {
            CompactionsSection.Visibility = Visibility.Collapsed;
        }

        // Row 4: Top Tool Consumers + Heaviest Steps
        RenderSessionToolBars(session);
        RenderHeaviestSteps(session);

        // Subagent Rollup
        if (session.Subagents.Count > 0)
        {
            SubagentsCard.Visibility = Visibility.Visible;
            SubagentsHeader.Text = $"Subagent Rollup ({session.Subagents.Count})";
            SubagentsSubtitle.Text = $"Combined: {FormatUtil.Tokens(session.RolledUpTotals.TotalTokens)} tok · {session.RolledUpTotals.Invocations} calls · {FormatUtil.Usd(session.RolledUpTotals.EstimatedCostUsd)}";
            SubagentsGrid.ItemsSource = session.Subagents.Select(sub => new
            {
                sub.Role,
                Type = sub.TypeName,
                Calls = sub.Invocations.ToString(),
                Peak = FormatUtil.TokensCompact(sub.PeakContextTokens),
                Total = FormatUtil.Tokens(sub.TotalInputTokens + sub.TotalCacheReadTokens + sub.TotalOutputTokens),
                Cost = FormatUtil.Usd(sub.EstimatedCostUsd),
            }).ToList();
        }
        else
        {
            SubagentsCard.Visibility = Visibility.Collapsed;
        }

        RenderStepTable();
    }

    private void RenderCategoryBreakdown(SessionDetail session)
    {
        CategoryBreakdownHost.Children.Clear();
        var fgPrimary = TryFindResource("FgPrimaryBrush") as System.Windows.Media.Brush ?? System.Windows.Media.Brushes.White;
        var fgSec = TryFindResource("FgSecondaryBrush") as System.Windows.Media.Brush ?? System.Windows.Media.Brushes.LightGray;
        var fgMuted = TryFindResource("FgMutedBrush") as System.Windows.Media.Brush ?? System.Windows.Media.Brushes.Gray;
        var track = TryFindResource("TrackBrush") as System.Windows.Media.Brush ?? System.Windows.Media.Brushes.DimGray;
        var conv = new BrushConverter();

        void AddRow(System.Windows.Media.Brush dotBrush, string label, string tokensStr, string pctStr)
        {
            var row = new Grid { Margin = new Thickness(0, 0, 0, 9) };
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(76) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(86) });

            var dot = new Ellipse { Width = 8.5, Height = 8.5, Fill = dotBrush, Margin = new Thickness(0, 0, 10, 0), VerticalAlignment = VerticalAlignment.Center };
            row.Children.Add(dot);

            var nameTb = new TextBlock { Text = label, FontSize = 12, Foreground = fgPrimary, VerticalAlignment = VerticalAlignment.Center, TextTrimming = TextTrimming.CharacterEllipsis };
            Grid.SetColumn(nameTb, 1);
            row.Children.Add(nameTb);

            var tokTb = new TextBlock { Text = tokensStr, FontFamily = new System.Windows.Media.FontFamily("Consolas"), FontSize = 12, FontWeight = FontWeights.SemiBold, Foreground = fgPrimary, HorizontalAlignment = System.Windows.HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Center };
            Grid.SetColumn(tokTb, 2);
            row.Children.Add(tokTb);

            var pctTb = new TextBlock { Text = pctStr, FontFamily = new System.Windows.Media.FontFamily("Consolas"), FontSize = 11.5, Foreground = fgSec, HorizontalAlignment = System.Windows.HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Center };
            Grid.SetColumn(pctTb, 3);
            row.Children.Add(pctTb);

            CategoryBreakdownHost.Children.Add(row);
        }

        foreach (var c in session.Categories.OrderByDescending(x => x.Tokens))
        {
            if (c.Tokens <= 0) continue;
            var brush = (System.Windows.Media.Brush)conv.ConvertFromString(c.ColorHex)!;
            AddRow(brush, c.Label, FormatUtil.TokensCompact(c.Tokens), $"{c.PercentageOfContext:F1}%");
        }

        double freePct = (double)session.FreeSpaceTokens / Math.Max(1, session.ContextWindowSize) * 100.0;
        AddRow(track, "Free Space", FormatUtil.TokensCompact(session.FreeSpaceTokens), $"{freePct:F1}% free");
    }

    private void RenderSessionToolBars(SessionDetail session)
    {
        SessionToolsBarsHost.Children.Clear();
        var fgPrimary = TryFindResource("FgPrimaryBrush") as System.Windows.Media.Brush ?? System.Windows.Media.Brushes.White;
        var fgMuted = TryFindResource("FgMutedBrush") as System.Windows.Media.Brush ?? System.Windows.Media.Brushes.Gray;
        var track = TryFindResource("TrackBrush") as System.Windows.Media.Brush ?? System.Windows.Media.Brushes.DimGray;
        var cyan = TryFindResource("CyanBrush") as System.Windows.Media.Brush ?? System.Windows.Media.Brushes.DeepSkyBlue;

        var top = session.Tools.Take(6).ToList();
        if (top.Count == 0)
        {
            SessionToolsBarsHost.Children.Add(new TextBlock { Text = "No tool calls in this session.", Foreground = fgMuted, FontSize = 12 });
            return;
        }

        long maxTok = Math.Max(1L, top.Max(t => t.EstimatedTotalTokens));
        foreach (var t in top)
        {
            double pctOfMax = Math.Clamp((double)t.EstimatedTotalTokens / maxTok * 100.0, 4, 100);
            var row = new Grid { Margin = new Thickness(0, 0, 0, 9), ToolTip = $"{t.Name}: {t.CallCount} calls · Args {FormatUtil.Tokens(t.EstimatedArgTokens)} · Out {FormatUtil.Tokens(t.EstimatedOutputTokens)}" };
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(132) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(70) });

            var nameTb = new TextBlock
            {
                Text = t.Name,
                FontFamily = new System.Windows.Media.FontFamily("Consolas"),
                FontSize = 12,
                Foreground = fgPrimary,
                VerticalAlignment = VerticalAlignment.Center,
                TextTrimming = TextTrimming.CharacterEllipsis,
            };
            row.Children.Add(nameTb);

            var barHost = new Border { Height = 6, CornerRadius = new CornerRadius(3), Background = track, ClipToBounds = true, Margin = new Thickness(10, 0, 12, 0), VerticalAlignment = VerticalAlignment.Center };
            var barGrid = new Grid();
            FillProgressBar(barGrid, pctOfMax, cyan, cornerRadius: 3);
            barHost.Child = barGrid;
            Grid.SetColumn(barHost, 1);
            row.Children.Add(barHost);

            var valTb = new TextBlock
            {
                Text = FormatUtil.TokensCompact(t.EstimatedTotalTokens),
                FontFamily = new System.Windows.Media.FontFamily("Consolas"),
                FontSize = 12,
                FontWeight = FontWeights.SemiBold,
                Foreground = fgPrimary,
                HorizontalAlignment = System.Windows.HorizontalAlignment.Right,
                VerticalAlignment = VerticalAlignment.Center,
            };
            Grid.SetColumn(valTb, 2);
            row.Children.Add(valTb);

            SessionToolsBarsHost.Children.Add(row);
        }
    }

    private void RenderHeaviestSteps(SessionDetail session)
    {
        HeaviestStepsHost.Children.Clear();
        var fgPrimary = TryFindResource("FgPrimaryBrush") as System.Windows.Media.Brush ?? System.Windows.Media.Brushes.White;
        var fgMuted = TryFindResource("FgMutedBrush") as System.Windows.Media.Brush ?? System.Windows.Media.Brushes.Gray;
        var bgHover = TryFindResource("BgRowHoverBrush") as System.Windows.Media.Brush ?? System.Windows.Media.Brushes.DimGray;

        var items = session.HeaviestSteps.Take(6).ToList();
        if (items.Count == 0)
        {
            HeaviestStepsHost.Children.Add(new TextBlock { Text = "No step payloads recorded yet.", Foreground = fgMuted, FontSize = 12 });
            return;
        }

        foreach (var h in items)
        {
            var bd = new Border
            {
                CornerRadius = new CornerRadius(6),
                Padding = new Thickness(8, 5, 8, 5),
                Margin = new Thickness(0, 0, 0, 3),
                Background = System.Windows.Media.Brushes.Transparent,
                Cursor = System.Windows.Input.Cursors.Hand,
            };
            bd.MouseEnter += (_, _) => bd.Background = bgHover;
            bd.MouseLeave += (_, _) => bd.Background = System.Windows.Media.Brushes.Transparent;
            int stepIdx = h.StepIndex;
            bd.MouseLeftButtonUp += (_, _) =>
            {
                StepFilterBox.Text = stepIdx.ToString();
            };

            var row = new Grid();
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(44) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

            row.Children.Add(new TextBlock { Text = $"#{h.StepIndex}", FontFamily = new System.Windows.Media.FontFamily("Consolas"), FontSize = 12, Foreground = fgMuted, VerticalAlignment = VerticalAlignment.Center });

            var lbl = new TextBlock { Text = h.Label, FontSize = 12, Foreground = fgPrimary, TextTrimming = TextTrimming.CharacterEllipsis, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(4, 0, 8, 0) };
            Grid.SetColumn(lbl, 1);
            row.Children.Add(lbl);

            var tok = new TextBlock { Text = FormatUtil.TokensCompact(h.EstimatedTokens), FontFamily = new System.Windows.Media.FontFamily("Consolas"), FontSize = 12, FontWeight = FontWeights.SemiBold, Foreground = fgPrimary, VerticalAlignment = VerticalAlignment.Center };
            Grid.SetColumn(tok, 2);
            row.Children.Add(tok);

            bd.Child = row;
            HeaviestStepsHost.Children.Add(bd);
        }
    }

    private void RenderStepTable()
    {
        if (_snapshot is null) return;
        var session = GetInspectedSession(_snapshot);
        if (session is null) return;

        IEnumerable<StepTelemetry> steps = session.Steps;
        steps = _selectedStepKindFilter switch
        {
            "LLM" => steps.Where(st => st.Type != "CHECKPOINT" && st.ToolCallCount == 0),
            "TOOLS" => steps.Where(st => st.ToolCallCount > 0),
            "CHECKPOINT" => steps.Where(st => st.Type == "CHECKPOINT"),
            _ => steps,
        };

        var query = StepFilterBox.Text.Trim();
        if (!string.IsNullOrEmpty(query))
        {
            steps = steps.Where(st =>
                st.ModelDisplayName.Contains(query, StringComparison.OrdinalIgnoreCase) ||
                st.Type.Contains(query, StringComparison.OrdinalIgnoreCase) ||
                st.StepIndex.ToString().Contains(query, StringComparison.OrdinalIgnoreCase) ||
                st.ToolNames.Any(t => t.Contains(query, StringComparison.OrdinalIgnoreCase)));
        }

        StepsHeader.Text = $"Per-Step Context Telemetry ({session.Steps.Count} steps)";
        StepsGrid.ItemsSource = steps.Reverse().Take(80).Select(st => new
        {
            Step = $"#{st.StepIndex}",
            Model = st.Type == "CHECKPOINT" ? "[CHECKPOINT]" : (st.HasError ? $"{st.ModelDisplayName} [ERR]" : st.ModelDisplayName),
            Context = FormatUtil.TokensCompact(st.TotalContextTokens),
            Delta = (st.ContextDelta >= 0 ? "+" : "") + FormatUtil.TokensCompact(st.ContextDelta),
            Input = FormatUtil.TokensCompact(st.InputTokens),
            Cache = FormatUtil.TokensCompact(st.CacheReadTokens),
            Hit = $"{st.CacheHitRate * 100:0}%",
            Output = FormatUtil.TokensCompact(st.OutputTokens),
            Tools = st.ToolNames.Count == 0
                ? "—"
                : string.Join(", ", st.ToolNames.Take(3)) + (st.ToolNames.Count > 3 ? $" +{st.ToolNames.Count - 3}" : ""),
        }).ToList();
    }

    // =========================================================================
    // TAB 3: MODELS & TOOLS (Panel 4)
    // =========================================================================
    private void RenderModelsTab(DashboardSnapshot snap)
    {
        var win = snap.Windows[_selectedWindow];
        ModelsHeader.Text = $"Model Efficiency Breakdown · {win.Label}";

        // Rich Model Efficiency rows matching Panel 4 (inline cache pills + share bars!)
        ModelsTableHost.Children.Clear();
        var fgPrimary = TryFindResource("FgPrimaryBrush") as System.Windows.Media.Brush ?? System.Windows.Media.Brushes.White;
        var fgSec = TryFindResource("FgSecondaryBrush") as System.Windows.Media.Brush ?? System.Windows.Media.Brushes.LightGray;
        var fgMuted = TryFindResource("FgMutedBrush") as System.Windows.Media.Brush ?? System.Windows.Media.Brushes.Gray;
        var borderSub = TryFindResource("BorderSubtleBrush") as System.Windows.Media.Brush ?? System.Windows.Media.Brushes.DimGray;
        var bgHover = TryFindResource("BgRowHoverBrush") as System.Windows.Media.Brush ?? System.Windows.Media.Brushes.DimGray;
        var track = TryFindResource("TrackBrush") as System.Windows.Media.Brush ?? System.Windows.Media.Brushes.DimGray;
        var cyan = TryFindResource("CyanBrush") as System.Windows.Media.Brush ?? System.Windows.Media.Brushes.DeepSkyBlue;

        if (win.ByModel.Count == 0)
        {
            ModelsTableHost.Children.Add(new TextBlock { Text = "No model invocations recorded in this window.", Foreground = fgMuted, FontSize = 12, Margin = new Thickness(8, 10, 8, 6) });
        }
        else
        {
            long maxModelTok = Math.Max(1L, win.ByModel.Max(m => m.TotalTokens));
            foreach (var m in win.ByModel)
            {
                var rowHost = new Border
                {
                    CornerRadius = new CornerRadius(7),
                    Padding = new Thickness(8, 9, 8, 9),
                    BorderBrush = borderSub,
                    BorderThickness = new Thickness(0, 0, 0, 1),
                    Background = System.Windows.Media.Brushes.Transparent,
                };
                rowHost.MouseEnter += (_, _) => rowHost.Background = bgHover;
                rowHost.MouseLeave += (_, _) => rowHost.Background = System.Windows.Media.Brushes.Transparent;

                var g = new Grid();
                g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1.9, GridUnitType.Star) });
                g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1.2, GridUnitType.Star) });
                g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(0.75, GridUnitType.Star) });
                g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(0.75, GridUnitType.Star) });
                g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1.15, GridUnitType.Star) });
                g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(0.85, GridUnitType.Star) });
                g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1.5, GridUnitType.Star) });
                g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(0.85, GridUnitType.Star) });

                // Model name
                g.Children.Add(new TextBlock { Text = m.DisplayName, FontSize = 12.5, FontWeight = FontWeights.Medium, Foreground = fgPrimary, VerticalAlignment = VerticalAlignment.Center, TextTrimming = TextTrimming.CharacterEllipsis });

                // Quota Group pill
                var groupPill = new Border
                {
                    Background = TryFindResource("BgPrimaryBrush") as System.Windows.Media.Brush,
                    BorderBrush = TryFindResource("BorderPrimaryBrush") as System.Windows.Media.Brush,
                    BorderThickness = new Thickness(1),
                    CornerRadius = new CornerRadius(6),
                    Padding = new Thickness(8, 2, 8, 2),
                    HorizontalAlignment = System.Windows.HorizontalAlignment.Left,
                    VerticalAlignment = VerticalAlignment.Center,
                    Child = new TextBlock { Text = m.QuotaGroupLabel, FontSize = 10.5, Foreground = fgSec },
                };
                Grid.SetColumn(groupPill, 1);
                g.Children.Add(groupPill);

                // Context window
                var ctxTb = new TextBlock { Text = FormatUtil.TokensCompact(m.ContextWindow), FontFamily = new System.Windows.Media.FontFamily("Consolas"), FontSize = 12, Foreground = fgPrimary, HorizontalAlignment = System.Windows.HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Center };
                Grid.SetColumn(ctxTb, 2);
                g.Children.Add(ctxTb);

                // Calls
                var callsTb = new TextBlock { Text = $"{m.Invocations} calls", FontFamily = new System.Windows.Media.FontFamily("Consolas"), FontSize = 12, Foreground = fgSec, HorizontalAlignment = System.Windows.HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Center };
                Grid.SetColumn(callsTb, 3);
                g.Children.Add(callsTb);

                // Avg / Peak
                var avgPeakTb = new TextBlock { Text = $"{FormatUtil.TokensCompact(m.AvgContextTokens)} / {FormatUtil.TokensCompact(m.PeakContextTokens)}", FontFamily = new System.Windows.Media.FontFamily("Consolas"), FontSize = 12, Foreground = fgPrimary, HorizontalAlignment = System.Windows.HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Center };
                Grid.SetColumn(avgPeakTb, 4);
                g.Children.Add(avgPeakTb);

                // Cache Hit Pill
                string cacheBgKey = m.CacheHitRate >= 0.85 ? "OkBgBrush" : (m.CacheHitRate >= 0.55 ? "WarnBgBrush" : "DangerBgBrush");
                string cacheFgKey = m.CacheHitRate >= 0.85 ? "OkBrush" : (m.CacheHitRate >= 0.55 ? "WarnBrush" : "DangerBrush");
                var cachePill = new Border
                {
                    Background = TryFindResource(cacheBgKey) as System.Windows.Media.Brush,
                    CornerRadius = new CornerRadius(9),
                    Padding = new Thickness(8, 2, 8, 2),
                    HorizontalAlignment = System.Windows.HorizontalAlignment.Right,
                    VerticalAlignment = VerticalAlignment.Center,
                    Child = new TextBlock
                    {
                        Text = $"{m.CacheHitRate * 100:F1}%",
                        FontFamily = new System.Windows.Media.FontFamily("Consolas"),
                        FontSize = 11,
                        FontWeight = FontWeights.Bold,
                        Foreground = TryFindResource(cacheFgKey) as System.Windows.Media.Brush,
                    },
                };
                Grid.SetColumn(cachePill, 5);
                g.Children.Add(cachePill);

                // Total + inline proportional share bar
                var totalGrid = new Grid { Margin = new Thickness(12, 0, 8, 0), VerticalAlignment = VerticalAlignment.Center };
                totalGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(60) });
                totalGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                totalGrid.Children.Add(new TextBlock
                {
                    Text = FormatUtil.TokensCompact(m.TotalTokens),
                    FontFamily = new System.Windows.Media.FontFamily("Consolas"),
                    FontSize = 12,
                    FontWeight = FontWeights.SemiBold,
                    Foreground = fgPrimary,
                    HorizontalAlignment = System.Windows.HorizontalAlignment.Right,
                    Margin = new Thickness(0, 0, 8, 0),
                });
                var barHost = new Border { Height = 5.5, CornerRadius = new CornerRadius(2.75), Background = track, ClipToBounds = true, VerticalAlignment = VerticalAlignment.Center };
                var barGrid = new Grid();
                FillProgressBar(barGrid, Math.Clamp((double)m.TotalTokens / maxModelTok * 100.0, 3, 100), cyan, cornerRadius: 2.75);
                barHost.Child = barGrid;
                Grid.SetColumn(barHost, 1);
                totalGrid.Children.Add(barHost);
                Grid.SetColumn(totalGrid, 6);
                g.Children.Add(totalGrid);

                // Ref Cost
                var costTb = new TextBlock { Text = FormatUtil.Usd(m.EstimatedCostUsd), FontFamily = new System.Windows.Media.FontFamily("Consolas"), FontSize = 12, FontWeight = FontWeights.SemiBold, Foreground = fgPrimary, HorizontalAlignment = System.Windows.HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Center };
                Grid.SetColumn(costTb, 7);
                g.Children.Add(costTb);

                rowHost.Child = g;
                ModelsTableHost.Children.Add(rowHost);
            }
        }

        // Global Tool Context Bloat Ranking (clean proportional bars with non-overlapping labels)
        GlobalToolsBarsHost.Children.Clear();
        var topTools = win.TopTools.Take(8).ToList();
        if (topTools.Count == 0)
        {
            GlobalToolsBarsHost.Children.Add(new TextBlock { Text = "No tool calls recorded in this window.", Foreground = fgMuted, FontSize = 12 });
        }
        else
        {
            string[] palette = ["#EF6C57", "#E69553", "#38BDF8", "#60A5FA", "#A78BFA", "#34D399", "#FBBF24", "#94A3B8"];
            var conv = new BrushConverter();
            long maxToolTok = Math.Max(1L, topTools.Max(t => t.EstimatedTotalTokens));

            for (int i = 0; i < topTools.Count; i++)
            {
                var t = topTools[i];
                var fillBrush = (System.Windows.Media.Brush)conv.ConvertFromString(palette[i % palette.Length])!;
                double barPct = Math.Clamp((double)t.EstimatedTotalTokens / maxToolTok * 100.0, 3, 100);

                var box = new StackPanel { Margin = new Thickness(0, 0, 0, 11) };
                var header = new Grid { Margin = new Thickness(0, 0, 0, 5) };
                header.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                header.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                header.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(52) });

                header.Children.Add(new TextBlock
                {
                    Text = t.Name,
                    FontFamily = new System.Windows.Media.FontFamily("Consolas"),
                    FontSize = 12,
                    FontWeight = FontWeights.SemiBold,
                    Foreground = fgPrimary,
                });

                var metaTb = new TextBlock
                {
                    Text = $"{t.CallCount} calls · {FormatUtil.TokensCompact(t.EstimatedTotalTokens)} tok",
                    FontFamily = new System.Windows.Media.FontFamily("Consolas"),
                    FontSize = 11,
                    Foreground = fgMuted,
                    VerticalAlignment = VerticalAlignment.Center,
                    Margin = new Thickness(8, 0, 8, 0),
                };
                Grid.SetColumn(metaTb, 1);
                header.Children.Add(metaTb);

                var pctTb = new TextBlock
                {
                    Text = $"{t.ShareOfToolTokens * 100:F1}%",
                    FontFamily = new System.Windows.Media.FontFamily("Consolas"),
                    FontSize = 12,
                    FontWeight = FontWeights.Bold,
                    Foreground = fgPrimary,
                    HorizontalAlignment = System.Windows.HorizontalAlignment.Right,
                };
                Grid.SetColumn(pctTb, 2);
                header.Children.Add(pctTb);
                box.Children.Add(header);

                var barHost = new Border { Height = 7, CornerRadius = new CornerRadius(3.5), Background = track, ClipToBounds = true };
                var barGrid = new Grid();
                FillProgressBar(barGrid, barPct, fillBrush, cornerRadius: 3.5);
                barHost.Child = barGrid;
                box.Children.Add(barHost);

                GlobalToolsBarsHost.Children.Add(box);
            }
        }

        // Account Available Models (Panel 4 clean status-dot list)
        AccountModelsHeader.Text = $"Account Available Models ({snap.AvailableModels.Count})";
        AccountModelsListHost.Children.Clear();
        var usedIds = new HashSet<string>(win.ByModel.Select(m => m.ModelId), StringComparer.OrdinalIgnoreCase);

        if (snap.AvailableModels.Count == 0)
        {
            AccountModelsListHost.Children.Add(new TextBlock { Text = "Click Refresh Models to query `agy models`.", Foreground = fgMuted, FontSize = 12 });
        }
        else
        {
            foreach (var m in snap.AvailableModels.Take(12))
            {
                bool activeInWindow = usedIds.Contains(m.Id);
                var dotBrush = activeInWindow
                    ? TryFindResource("OkBrush") as System.Windows.Media.Brush
                    : (m.QuotaGroup == QuotaGroupId.PartnerClaudeGpt
                        ? TryFindResource("WarnBrush") as System.Windows.Media.Brush
                        : TryFindResource("FgMutedBrush") as System.Windows.Media.Brush);

                var row = new Grid { Margin = new Thickness(0, 0, 0, 10) };
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(58) });

                row.Children.Add(new Ellipse { Width = 7, Height = 7, Fill = dotBrush, Margin = new Thickness(0, 0, 10, 0), VerticalAlignment = VerticalAlignment.Center });

                var nameTb = new TextBlock { Text = m.DisplayName, FontSize = 12.5, Foreground = fgPrimary, VerticalAlignment = VerticalAlignment.Center, TextTrimming = TextTrimming.CharacterEllipsis, ToolTip = m.Id };
                Grid.SetColumn(nameTb, 1);
                row.Children.Add(nameTb);

                var grpPill = new Border
                {
                    Background = TryFindResource("BgPrimaryBrush") as System.Windows.Media.Brush,
                    BorderBrush = TryFindResource("BorderPrimaryBrush") as System.Windows.Media.Brush,
                    BorderThickness = new Thickness(1),
                    CornerRadius = new CornerRadius(6),
                    Padding = new Thickness(8, 2, 8, 2),
                    Margin = new Thickness(8, 0, 8, 0),
                    VerticalAlignment = VerticalAlignment.Center,
                    Child = new TextBlock { Text = m.QuotaGroupLabel, FontSize = 10.5, Foreground = fgSec },
                };
                Grid.SetColumn(grpPill, 2);
                row.Children.Add(grpPill);

                var winPill = new Border
                {
                    Background = TryFindResource("BgTertiaryBrush") as System.Windows.Media.Brush,
                    CornerRadius = new CornerRadius(6),
                    Padding = new Thickness(7, 2, 7, 2),
                    HorizontalAlignment = System.Windows.HorizontalAlignment.Right,
                    VerticalAlignment = VerticalAlignment.Center,
                    Child = new TextBlock { Text = FormatUtil.TokensCompact(m.ContextWindow), FontFamily = new System.Windows.Media.FontFamily("Consolas"), FontSize = 10.5, FontWeight = FontWeights.SemiBold, Foreground = fgPrimary },
                };
                Grid.SetColumn(winPill, 3);
                row.Children.Add(winPill);

                AccountModelsListHost.Children.Add(row);
            }
        }
    }

    // =========================================================================
    // TAB 4: SESSIONS & SETTINGS (Panel 5)
    // =========================================================================
    private void RenderSessionsTable()
    {
        if (_snapshot is null) return;
        bool showSubs = ShowSubagentsCheck.IsChecked == true;
        string q = SessionSearchBox.Text.Trim();

        var filtered = _snapshot.Sessions.Where(s =>
        {
            if (!showSubs && s.IsSubagent) return false;
            if (string.IsNullOrEmpty(q)) return true;
            return s.Title.Contains(q, StringComparison.OrdinalIgnoreCase) ||
                   s.ConversationId.Contains(q, StringComparison.OrdinalIgnoreCase) ||
                   s.PrimaryModelDisplayName.Contains(q, StringComparison.OrdinalIgnoreCase);
        }).ToList();

        SessionsCountText.Text = $"· {filtered.Count} of {_snapshot.Sessions.Count} sessions";

        int rank = 1;
        SessionsGrid.ItemsSource = filtered.Select(s =>
        {
            string bgKey = s.ContextUsedPercent >= _settings.ContextCriticalPercent
                ? "DangerBgBrush"
                : (s.ContextUsedPercent >= _settings.ContextWarnPercent ? "WarnBgBrush" : "CyanBgBrush");
            string fgKey = s.ContextUsedPercent >= _settings.ContextCriticalPercent
                ? "DangerBrush"
                : (s.ContextUsedPercent >= _settings.ContextWarnPercent ? "WarnBrush" : "CyanBrush");

            return new SessionGridRow(
                rank++,
                s.ConversationId,
                (s.ConversationId == _snapshot.ActiveConversationId ? "★ " : "") + (s.IsSubagent ? "↳ " : "") + s.Title,
                FormatUtil.SurfaceTag(s.Surface),
                s.PrimaryModelDisplayName,
                FormatUtil.TokensCompact(s.CurrentContextTokens),
                $"{s.ContextUsedPercent:F1}%",
                TryFindResource(bgKey) as System.Windows.Media.Brush ?? System.Windows.Media.Brushes.Transparent,
                TryFindResource(fgKey) as System.Windows.Media.Brush ?? System.Windows.Media.Brushes.White,
                FormatUtil.TokensCompact(s.TotalBilledTokens),
                $"{s.OverallCacheHitRate * 100:0}%",
                $"{s.CompactionCount} CP",
                FormatUtil.Usd(s.LiveCostUsd ?? s.EstimatedCostUsd),
                FormatUtil.RelativeTime(s.LastActiveAt));
        }).ToList();
    }

    private void RenderCliSyncStatus(DashboardSnapshot snap)
    {
        var exe = Environment.ProcessPath ?? "UsageOrb.exe";
        bool configured = TelemetryStore.IsCliStatusLineConfigured(exe);

        if (snap.StatusLineConnected && snap.StatusLineLastSeenAt.HasValue)
        {
            CliSyncBadge.Background = TryFindResource("OkBgBrush") as System.Windows.Media.Brush;
            CliSyncBadgeText.Foreground = TryFindResource("OkBrush") as System.Windows.Media.Brush;
            CliSyncBadgeText.Text = $"Synced {FormatUtil.RelativeTime(snap.StatusLineLastSeenAt.Value)}";
        }
        else if (configured)
        {
            CliSyncBadge.Background = TryFindResource("CyanBgBrush") as System.Windows.Media.Brush;
            CliSyncBadgeText.Foreground = TryFindResource("CyanBrush") as System.Windows.Media.Brush;
            CliSyncBadgeText.Text = "Configured · Run agy";
        }
        else
        {
            CliSyncBadge.Background = TryFindResource("BgTertiaryBrush") as System.Windows.Media.Brush;
            CliSyncBadgeText.Foreground = TryFindResource("FgSecondaryBrush") as System.Windows.Media.Brush;
            CliSyncBadgeText.Text = "Not linked";
        }

        var lines = new List<string>
        {
            $"CLI Settings:  {AntigravityPaths.GetCliSettingsFilePath()}",
            $"Quota Cache:   {AntigravityPaths.GetStatusLineStateFilePath()}",
        };
        foreach (var root in snap.ScannedRoots)
        {
            lines.Add($"Brain Root:    {root}");
        }

        DataPathsText.Text = string.Join(Environment.NewLine, lines);
    }

    private void UpdateCliCommandText()
    {
        var exe = Environment.ProcessPath ?? "UsageOrb.exe";
        StatusLineCommandBox.Text = $"/statusline {TelemetryStore.BuildCliStatusLineCommand(exe)}";
    }

    private void PopulateSettingsControls()
    {
        _draftShape = _settings.WidgetShape;
        _draftAnchor = _settings.AnchorCorner;
        _draftOrbSize = _settings.OrbSizePx;
        _draftTheme = _settings.Theme;

        SelectComboByTag(DockModeCombo, _settings.DockMode.ToString());
        OpacitySlider.Value = _settings.IdleOpacity;
        OpacityLabel.Text = $"{(int)Math.Round(_settings.IdleOpacity * 100)}%";
        WarnPctBox.Text = _settings.ContextWarnPercent.ToString("0");
        CritPctBox.Text = _settings.ContextCriticalPercent.ToString("0");
        long fiveHourBudget = _settings.FiveHourTokenBudget ?? _settings.FiveHourEstBaselineTokens;
        EstBase5hBox.Text = fiveHourBudget > 0 ? FormatUtil.TokensCompact(fiveHourBudget) : "";
        long weeklyBudget = _settings.WeeklyTokenBudget ?? _settings.WeeklyEstBaselineTokens;
        EstBase7dBox.Text = weeklyBudget > 0 ? FormatUtil.TokensCompact(weeklyBudget) : "";
        StartWithWindowsCheck.IsChecked = _settings.StartWithWindows;

        RebuildSettingsSegments();
    }

    private void RebuildSettingsSegments()
    {
        // 1. Widget Shape segmented toggle (Circular Orb | 3-Metric Pill)
        ShapeSegmentHost.Children.Clear();
        ShapeSegmentHost.ColumnDefinitions.Clear();
        ShapeSegmentHost.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        ShapeSegmentHost.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

        var orbBtn = CreateSegmentButton("Circular Orb", _draftShape == FloatingWidgetShape.CircularOrb, new Thickness(8, 5, 8, 5), 11.5);
        orbBtn.Click += (_, _) => { _draftShape = FloatingWidgetShape.CircularOrb; RebuildSettingsSegments(); };
        Grid.SetColumn(orbBtn, 0);
        ShapeSegmentHost.Children.Add(orbBtn);

        var pillBtn = CreateSegmentButton("3-Metric Pill", _draftShape == FloatingWidgetShape.CompactPill, new Thickness(8, 5, 8, 5), 11.5);
        pillBtn.Click += (_, _) => { _draftShape = FloatingWidgetShape.CompactPill; RebuildSettingsSegments(); };
        Grid.SetColumn(pillBtn, 1);
        ShapeSegmentHost.Children.Add(pillBtn);

        // 2. Visual 4-Corner Anchor Grid (TL, TR, BL, BR)
        AnchorGridHost.Children.Clear();
        (OrbAnchorCorner Corner, string Code)[] corners =
        [
            (OrbAnchorCorner.TopLeft, "TL"),
            (OrbAnchorCorner.TopRight, "TR"),
            (OrbAnchorCorner.BottomLeft, "BL"),
            (OrbAnchorCorner.BottomRight, "BR"),
        ];
        foreach (var (corner, code) in corners)
        {
            bool active = _draftAnchor == corner;
            var captured = corner;
            var cBtn = CreateSegmentButton(code, active, new Thickness(2), 10.5, accentActive: true);
            cBtn.Margin = new Thickness(1.5);
            if (!active)
            {
                cBtn.Background = TryFindResource("BgPrimaryBrush") as System.Windows.Media.Brush;
            }

            cBtn.Click += (_, _) => { _draftAnchor = captured; RebuildSettingsSegments(); };
            AnchorGridHost.Children.Add(cBtn);
        }

        // 3. Orb Size presets (32 | 40 | 48)
        OrbSizeSegmentHost.Children.Clear();
        foreach (int sz in new[] { 32, 40, 48 })
        {
            int captured = sz;
            var sBtn = CreateSegmentButton(sz.ToString(), _draftOrbSize == sz, new Thickness(10, 4, 10, 4), 11.5);
            sBtn.Click += (_, _) => { _draftOrbSize = captured; RebuildSettingsSegments(); };
            OrbSizeSegmentHost.Children.Add(sBtn);
        }

        // 4. Theme presets (System | Dark | Light)
        ThemeSegmentHost.Children.Clear();
        foreach (ThemePreference th in new[] { ThemePreference.System, ThemePreference.Dark, ThemePreference.Light })
        {
            var captured = th;
            var tBtn = CreateSegmentButton(th.ToString(), _draftTheme == th, new Thickness(10, 4, 10, 4), 11.5);
            tBtn.Click += (_, _) => { _draftTheme = captured; RebuildSettingsSegments(); };
            ThemeSegmentHost.Children.Add(tBtn);
        }
    }

    private static void SelectComboByTag(System.Windows.Controls.ComboBox combo, string tag)
    {
        foreach (var item in combo.Items)
        {
            if (item is ComboBoxItem cbi && string.Equals(cbi.Tag?.ToString(), tag, StringComparison.OrdinalIgnoreCase))
            {
                combo.SelectedItem = cbi;
                return;
            }
        }
    }

    private void OnSaveSettingsClicked(object sender, RoutedEventArgs e)
    {
        var next = _settings.Clone();
        next.WidgetShape = _draftShape;
        next.AnchorCorner = _draftAnchor;
        next.OrbSizePx = _draftOrbSize;
        next.Theme = _draftTheme;

        if ((DockModeCombo.SelectedItem as ComboBoxItem)?.Tag is string dm && Enum.TryParse<OrbDockMode>(dm, out var dock))
            next.DockMode = dock;

        next.IdleOpacity = Math.Round(OpacitySlider.Value, 2);
        if (double.TryParse(WarnPctBox.Text, out var wPct)) next.ContextWarnPercent = wPct;
        if (double.TryParse(CritPctBox.Text, out var cPct)) next.ContextCriticalPercent = cPct;

        var b5 = FormatUtil.ParseTokenShorthand(EstBase5hBox.Text);
        if (b5.HasValue || string.IsNullOrWhiteSpace(EstBase5hBox.Text))
        {
            next.FiveHourEstBaselineTokens = b5 ?? 0;
            next.FiveHourTokenBudget = null;
        }

        var b7 = FormatUtil.ParseTokenShorthand(EstBase7dBox.Text);
        if (b7.HasValue || string.IsNullOrWhiteSpace(EstBase7dBox.Text))
        {
            next.WeeklyEstBaselineTokens = b7 ?? 0;
            next.WeeklyTokenBudget = null;
        }

        next.StartWithWindows = StartWithWindowsCheck.IsChecked == true;

        _settings = next;
        SettingsSaved?.Invoke(next);
        ShowToast("Preferences saved.");
    }

    private void OnAutoConfigureCliClicked(object sender, RoutedEventArgs e)
    {
        var exe = Environment.ProcessPath ?? "UsageOrb.exe";
        var result = TelemetryStore.ConfigureCliStatusLine(exe);
        ShowToast(result.Success ? "CLI statusLine configured! Run agy to sync." : result.Message);
        if (_snapshot is not null) RenderCliSyncStatus(_snapshot);
    }

    private void OnCopyStatusLineCommand(object sender, RoutedEventArgs e)
    {
        try
        {
            System.Windows.Clipboard.SetText(StatusLineCommandBox.Text);
            ShowToast("Copied /statusline command.");
        }
        catch
        {
            // Ignore transient clipboard lock
        }
    }

    private void UpdatePinButtonState(string conversationId)
    {
        bool isPinned = !string.IsNullOrWhiteSpace(_pinnedConversationId) &&
                        string.Equals(_pinnedConversationId, conversationId, StringComparison.OrdinalIgnoreCase);
        PinSessionBtn.Content = isPinned ? "Pinned ✓ (Unpin)" : "Pin to Widget";
        PinSessionBtn.Foreground = TryFindResource(isPinned ? "CyanBrush" : "FgPrimaryBrush") as System.Windows.Media.Brush;
        PinSessionBtn.BorderBrush = TryFindResource(isPinned ? "CyanBrush" : "BorderPrimaryBrush") as System.Windows.Media.Brush;
    }

    private void OnPinSessionClicked(object sender, RoutedEventArgs e)
    {
        var session = _snapshot is null ? null : GetInspectedSession(_snapshot);
        if (session is null) return;
        bool alreadyPinned = string.Equals(_pinnedConversationId, session.ConversationId, StringComparison.OrdinalIgnoreCase);
        string? nextPin = alreadyPinned ? null : session.ConversationId;
        _pinnedConversationId = nextPin;
        SessionPinRequested?.Invoke(nextPin);
        ShowToast(nextPin is null ? "Floating widget returned to Auto follow." : "Pinned session to floating widget.");
    }

    private SessionDetail? GetInspectedSession(DashboardSnapshot snapshot) =>
        snapshot.Sessions.FirstOrDefault(s => string.Equals(s.ConversationId, _inspectedConversationId, StringComparison.OrdinalIgnoreCase))
        ?? _displaySession?.Session ?? snapshot.ActiveSession;

    private void OnInspectorSessionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_suppressUiEvents || _snapshot is null) return;
        if (InspectorSessionCombo.SelectedItem is SessionPickerItem item)
        {
            _inspectedConversationId = item.ConversationId;
            RenderContextTab(_snapshot);
        }
    }

    private void OnSessionsGridDoubleClick(object sender, MouseButtonEventArgs e)
    {
        if (SessionsGrid.SelectedItem is SessionGridRow row && _snapshot is not null)
        {
            _inspectedConversationId = row.ConversationId;
            RenderContextTab(_snapshot);
            SelectTab(1);
        }
    }

    private static void RenderStackedBarInto(Grid host, SessionDetail session)
    {
        host.Children.Clear();
        host.ColumnDefinitions.Clear();
        var conv = new BrushConverter();
        int col = 0;
        var nonZero = session.Categories.Where(c => c.Tokens > 0).ToList();
        foreach (var cat in nonZero)
        {
            host.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(Math.Max(0.4, cat.PercentageOfWindow), GridUnitType.Star) });
            var seg = new Border
            {
                Background = (System.Windows.Media.Brush)conv.ConvertFromString(cat.ColorHex)!,
                Margin = new Thickness(0, 0, 1, 0),
                ToolTip = $"{cat.Label}: {FormatUtil.Tokens(cat.Tokens)} ({cat.PercentageOfContext:F1}%)",
            };
            Grid.SetColumn(seg, col++);
            host.Children.Add(seg);
        }

        double rem = Math.Max(0, 100.0 - nonZero.Sum(c => c.PercentageOfWindow));
        if (rem > 0.2)
        {
            host.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(rem, GridUnitType.Star) });
        }
    }

    private static void FillProgressBar(Grid host, double pct, System.Windows.Media.Brush fill, double cornerRadius = 3)
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
            CornerRadius = new CornerRadius(cornerRadius),
        });
    }

    private Border MakeBadge(string text, string bgKey, string fgKey, double marginLeft = 6) => new()
    {
        Background = TryFindResource(bgKey) as System.Windows.Media.Brush,
        CornerRadius = new CornerRadius(7),
        Padding = new Thickness(8, 2.5, 8, 2.5),
        Margin = new Thickness(marginLeft, 0, 0, 2),
        Child = new TextBlock
        {
            Text = text,
            FontSize = 10.5,
            FontWeight = FontWeights.SemiBold,
            Foreground = TryFindResource(fgKey) as System.Windows.Media.Brush,
        },
    };
}
