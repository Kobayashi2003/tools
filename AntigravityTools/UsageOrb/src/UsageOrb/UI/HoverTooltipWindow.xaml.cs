using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using UsageOrb.Core;
using UsageOrb.Platform;

namespace UsageOrb.UI;

public partial class HoverTooltipWindow : Window
{
    public HoverTooltipWindow()
    {
        InitializeComponent();
        SourceInitialized += (_, _) =>
        {
            var hwnd = new WindowInteropHelper(this).Handle;
            NativeMethods.ApplyOverlayWindowStyles(hwnd, noActivate: true);
        };
    }

    public void UpdateContent(DashboardSnapshot? snapshot, AppSettings settings, ResolvedDisplaySession? resolved = null)
    {
        if (snapshot is null)
        {
            HeaderTitle.Text = "Loading Antigravity telemetry...";
            StatusPillText.Text = "SYNC";
            ContextPctText.Text = "—";
            ContextSubText.Text = "";
            FiveHourPctText.Text = "—";
            FiveHourMetaText.Text = "";
            WeeklyPctText.Text = "—";
            WeeklyMetaText.Text = "";
            FooterText.Text = "Click widget for details";
            return;
        }

        var now = DateTimeOffset.UtcNow;
        var active = resolved is null ? snapshot.ActiveSession : resolved.Session;
        var (q5, q7) = QuotaResolver.Resolve(snapshot, settings, now, active);

        HeaderTitle.Text = active is not null ? active.PrimaryModelDisplayName : "Antigravity Telemetry";

        if (resolved?.Source == SessionBindSource.ManualPin)
        {
            StatusPill.Background = TryFindResource("CyanBgBrush") as System.Windows.Media.Brush;
            StatusPillText.Foreground = TryFindResource("CyanBrush") as System.Windows.Media.Brush;
            StatusPillDot.Visibility = Visibility.Collapsed;
            StatusPillText.Text = "PINNED";
        }
        else if (active?.IsRecentlyWriting == true)
        {
            StatusPill.Background = TryFindResource("OkBgBrush") as System.Windows.Media.Brush;
            StatusPillDot.Fill = TryFindResource("OkBrush") as System.Windows.Media.Brush;
            StatusPillText.Foreground = TryFindResource("OkBrush") as System.Windows.Media.Brush;
            StatusPillDot.Visibility = Visibility.Visible;
            StatusPillText.Text = "LIVE";
        }
        else if (resolved?.Source is SessionBindSource.WindowTitleMatch or SessionBindSource.WorkspaceMatch)
        {
            StatusPill.Background = TryFindResource("AccentBgBrush") as System.Windows.Media.Brush;
            StatusPillText.Foreground = TryFindResource("AccentBrush") as System.Windows.Media.Brush;
            StatusPillDot.Visibility = Visibility.Collapsed;
            StatusPillText.Text = resolved.Source == SessionBindSource.WindowTitleMatch ? "MATCHED" : "WORKSPACE";
        }
        else
        {
            StatusPill.Background = TryFindResource("BgTertiaryBrush") as System.Windows.Media.Brush;
            StatusPillText.Foreground = TryFindResource("FgSecondaryBrush") as System.Windows.Media.Brush;
            StatusPillDot.Visibility = Visibility.Collapsed;
            StatusPillText.Text = active is not null ? FormatUtil.SurfaceTag(active.Surface) : "LOCAL";
        }

        // 1. Context Window
        if (active is not null)
        {
            var ctxBrush = ScreenPlacementHelper.BrushForContext(
                active.ContextUsedPercent,
                settings.ContextWarnPercent,
                settings.ContextCriticalPercent,
                this);
            ContextPctText.Text = $"{active.ContextUsedPercent:F1}%";
            ContextPctText.Foreground = ctxBrush;
            ContextSubText.Text = $"({FormatUtil.TokensCompact(active.CurrentContextTokens)}/{FormatUtil.TokensCompact(active.ContextWindowSize)})";
            FillBar(ContextBarGrid, active.ContextUsedPercent, ctxBrush);
        }
        else
        {
            ContextPctText.Text = "—";
            ContextPctText.Foreground = TryFindResource("FgMutedBrush") as System.Windows.Media.Brush;
            ContextSubText.Text = "(No matching chat)";
            FillBar(ContextBarGrid, 0, TryFindResource("TrackBrush") as System.Windows.Media.Brush);
        }

        // 2. 5-Hour Remaining
        var b5 = ScreenPlacementHelper.BrushForRemaining(q5.RemainingPercent, settings.QuotaLowPercent, this);
        FiveHourModeBadge.Background = TryFindResource(q5.IsLive ? "OkBgBrush" : "BgTertiaryBrush") as System.Windows.Media.Brush;
        FiveHourModeText.Foreground = TryFindResource(q5.IsLive ? "OkBrush" : "FgMutedBrush") as System.Windows.Media.Brush;
        FiveHourModeText.Text = q5.StatusBadge;
        FiveHourPctText.Text = q5.FormatPercent();
        FiveHourPctText.Foreground = b5;
        FiveHourMetaText.Text = q5.IsLive && q5.ResetInSeconds.HasValue
            ? FormatUtil.Duration(q5.ResetInSeconds)
            : q5.EstimatedBaselineTokens > 0
                ? $"{FormatUtil.TokensCompact(q5.WindowTokens)}/{FormatUtil.TokensCompact(q5.EstimatedBaselineTokens)}"
                : $"{FormatUtil.TokensCompact(q5.WindowTokens)} local tok";
        FillBar(FiveHourBarGrid, q5.RemainingPercent ?? 0, b5);

        // 3. Weekly Remaining
        var b7 = ScreenPlacementHelper.BrushForRemaining(q7.RemainingPercent, settings.QuotaLowPercent, this);
        WeeklyModeBadge.Background = TryFindResource(q7.IsLive ? "OkBgBrush" : "BgTertiaryBrush") as System.Windows.Media.Brush;
        WeeklyModeText.Foreground = TryFindResource(q7.IsLive ? "OkBrush" : "FgMutedBrush") as System.Windows.Media.Brush;
        WeeklyModeText.Text = q7.StatusBadge;
        WeeklyPctText.Text = q7.FormatPercent();
        WeeklyPctText.Foreground = b7;
        WeeklyMetaText.Text = q7.IsLive && q7.ResetInSeconds.HasValue
            ? FormatUtil.Duration(q7.ResetInSeconds)
            : q7.EstimatedBaselineTokens > 0
                ? $"{FormatUtil.TokensCompact(q7.WindowTokens)}/{FormatUtil.TokensCompact(q7.EstimatedBaselineTokens)}"
                : $"{FormatUtil.TokensCompact(q7.WindowTokens)} local tok";
        FillBar(WeeklyBarGrid, q7.RemainingPercent ?? 0, b7);

        double cacheRate = active?.OverallCacheHitRate ?? 0;
        string sessionHint = active is not null
            ? (active.Title.Length > 24 ? active.Title[..21] + "..." : active.Title)
            : "Click for details";
        FooterText.Text = $"Cache {cacheRate * 100:F1}% · {sessionHint}";
    }

    private static void FillBar(Grid host, double pct, System.Windows.Media.Brush? fill)
    {
        host.Children.Clear();
        host.ColumnDefinitions.Clear();
        double clamped = Math.Clamp(pct, 0, 100);
        if (clamped <= 0.1 || fill is null) return;

        host.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(Math.Max(1.0, clamped), GridUnitType.Star) });
        if (clamped < 99.8)
        {
            host.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(Math.Max(0.2, 100.0 - clamped), GridUnitType.Star) });
        }

        host.Children.Add(new Border
        {
            Background = fill,
            CornerRadius = new CornerRadius(2.25),
        });
    }

    public void ShowNear(Window orb)
    {
        ScreenPlacementHelper.PlaceNearOrb(this, orb, gapDip: 8);
        if (!IsVisible) Show();
    }
}
