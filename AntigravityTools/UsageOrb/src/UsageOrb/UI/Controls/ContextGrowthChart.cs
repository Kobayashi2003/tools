using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Shapes;
using UsageOrb.Core;

namespace UsageOrb.UI.Controls;

/// <summary>
/// Interactive Obsidian Glass vector chart plotting step-by-step total context, cached reads,
/// 200K / model-limit reference thresholds, and vertical CHECKPOINT compaction markers.
/// </summary>
public sealed class ContextGrowthChart : Canvas
{
    private SessionDetail? _session;

    public ContextGrowthChart()
    {
        ClipToBounds = true;
        SizeChanged += (_, _) => Redraw();
    }

    public void Update(SessionDetail? session)
    {
        _session = session;
        Redraw();
    }

    private void Redraw()
    {
        Children.Clear();
        double w = ActualWidth;
        double h = ActualHeight;
        if (w < 80 || h < 60) return;

        var fgMuted = TryFindResource("FgMutedBrush") as System.Windows.Media.Brush ?? System.Windows.Media.Brushes.Gray;
        var border = TryFindResource("BorderSubtleBrush") as System.Windows.Media.Brush ?? System.Windows.Media.Brushes.DimGray;
        var cyan = TryFindResource("CyanBrush") as System.Windows.Media.Brush ?? System.Windows.Media.Brushes.DeepSkyBlue;
        var ok = TryFindResource("OkBrush") as System.Windows.Media.Brush ?? System.Windows.Media.Brushes.MediumSeaGreen;
        var warn = TryFindResource("WarnBrush") as System.Windows.Media.Brush ?? System.Windows.Media.Brushes.Goldenrod;
        var danger = TryFindResource("DangerBrush") as System.Windows.Media.Brush ?? System.Windows.Media.Brushes.IndianRed;
        var purple = TryFindResource("PurpleBrush") as System.Windows.Media.Brush ?? System.Windows.Media.Brushes.MediumPurple;
        var bg1 = TryFindResource("BgSecondaryBrush") as System.Windows.Media.Brush ?? System.Windows.Media.Brushes.Black;

        if (_session is null || _session.Steps.Count == 0)
        {
            var empty = new TextBlock
            {
                Text = "No model invocations recorded in this session yet.",
                Foreground = fgMuted,
                FontSize = 12,
            };
            SetLeft(empty, Math.Max(12, w / 2 - 130));
            SetTop(empty, h / 2 - 10);
            Children.Add(empty);
            return;
        }

        var steps = _session.Steps;
        const double padL = 54;
        const double padR = 16;
        const double padT = 18;
        const double padB = 26;
        double plotW = Math.Max(20, w - padL - padR);
        double plotH = Math.Max(20, h - padT - padB);

        long maxStep = steps.Max(s => Math.Max(s.TotalContextTokens, s.Type == "CHECKPOINT" ? s.InputTokens : 0));
        double yMax = Math.Max(Math.Max(maxStep, 10_000L) * 1.15, Math.Min(_session.ContextWindowSize, Math.Max(maxStep, 10_000L) * 1.28));

        double XFor(int idx) => steps.Count == 1 ? padL + plotW / 2 : padL + (double)idx / (steps.Count - 1) * plotW;
        double YFor(double val) => padT + plotH - Math.Clamp(val / yMax, 0, 1) * plotH;

        // Horizontal grid & Y labels
        for (int t = 0; t <= 4; t++)
        {
            double val = yMax * t / 4.0;
            double y = YFor(val);
            Children.Add(new Line
            {
                X1 = padL,
                Y1 = y,
                X2 = w - padR,
                Y2 = y,
                Stroke = border,
                StrokeThickness = 1,
                StrokeDashArray = t == 0 ? null : new DoubleCollection([3, 4]),
            });

            var lbl = new TextBlock
            {
                Text = FormatUtil.TokensCompact(val),
                Foreground = fgMuted,
                FontSize = 10,
                FontFamily = new System.Windows.Media.FontFamily("Consolas"),
                Width = padL - 8,
                TextAlignment = TextAlignment.Right,
            };
            SetLeft(lbl, 0);
            SetTop(lbl, y - 7);
            Children.Add(lbl);
        }

        // 200K reference line
        if (200_000 <= yMax && 200_000 >= yMax * 0.12)
        {
            double y200 = YFor(200_000);
            Children.Add(new Line
            {
                X1 = padL,
                Y1 = y200,
                X2 = w - padR,
                Y2 = y200,
                Stroke = warn,
                StrokeThickness = 1,
                Opacity = 0.72,
                StrokeDashArray = new DoubleCollection([5, 4]),
            });
            var tag = new TextBlock { Text = "200K", Foreground = warn, FontSize = 9.5, FontWeight = FontWeights.SemiBold, FontFamily = new System.Windows.Media.FontFamily("Consolas") };
            SetLeft(tag, w - padR - 32);
            SetTop(tag, y200 - 14);
            Children.Add(tag);
        }

        // Model window limit line
        if (_session.ContextWindowSize <= yMax * 1.02)
        {
            double yLim = YFor(_session.ContextWindowSize);
            Children.Add(new Line
            {
                X1 = padL,
                Y1 = yLim,
                X2 = w - padR,
                Y2 = yLim,
                Stroke = danger,
                StrokeThickness = 1.2,
                Opacity = 0.85,
                StrokeDashArray = new DoubleCollection([4, 3]),
            });
            var tag = new TextBlock
            {
                Text = $"{FormatUtil.TokensCompact(_session.ContextWindowSize)} Limit",
                Foreground = danger,
                FontSize = 9.5,
                FontWeight = FontWeights.SemiBold,
                FontFamily = new System.Windows.Media.FontFamily("Consolas"),
            };
            SetLeft(tag, w - padR - 74);
            SetTop(tag, yLim - 14);
            Children.Add(tag);
        }

        // Area fills & polylines
        if (steps.Count > 1)
        {
            double baseY = padT + plotH;
            var totalPts = new PointCollection();
            var cachePts = new PointCollection();
            var totalArea = new PointCollection { new System.Windows.Point(XFor(0), baseY) };
            var cacheArea = new PointCollection { new System.Windows.Point(XFor(0), baseY) };

            for (int i = 0; i < steps.Count; i++)
            {
                double x = XFor(i);
                var ptTot = new System.Windows.Point(x, YFor(steps[i].TotalContextTokens));
                var ptCache = new System.Windows.Point(x, YFor(steps[i].CacheReadTokens));
                totalPts.Add(ptTot);
                cachePts.Add(ptCache);
                totalArea.Add(ptTot);
                cacheArea.Add(ptCache);
            }

            totalArea.Add(new System.Windows.Point(XFor(steps.Count - 1), baseY));
            cacheArea.Add(new System.Windows.Point(XFor(steps.Count - 1), baseY));

            Children.Add(new Polygon { Points = totalArea, Fill = cyan, Opacity = 0.14 });
            Children.Add(new Polygon { Points = cacheArea, Fill = ok, Opacity = 0.20 });
            Children.Add(new Polyline { Points = totalPts, Stroke = cyan, StrokeThickness = 2.1 });
            Children.Add(new Polyline { Points = cachePts, Stroke = ok, StrokeThickness = 1.35, StrokeDashArray = new DoubleCollection([3, 2]) });
        }

        // Interactive step dots & vertical CHECKPOINT markers
        double dotSize = steps.Count > 70 ? 5.0 : 6.5;
        for (int i = 0; i < steps.Count; i++)
        {
            var s = steps[i];
            double x = XFor(i);
            double y = YFor(s.TotalContextTokens);

            if (s.Type == "CHECKPOINT")
            {
                Children.Add(new Line
                {
                    X1 = x,
                    Y1 = padT,
                    X2 = x,
                    Y2 = padT + plotH,
                    Stroke = purple,
                    StrokeThickness = 1.5,
                    StrokeDashArray = new DoubleCollection([3, 3]),
                });

                var cpTag = new TextBlock
                {
                    Text = "CHECKPOINT",
                    Foreground = purple,
                    FontSize = 9,
                    FontWeight = FontWeights.SemiBold,
                    FontFamily = new System.Windows.Media.FontFamily("Consolas"),
                };
                SetLeft(cpTag, Math.Clamp(x + 4, padL, w - padR - 68));
                SetTop(cpTag, padT + plotH - 14);
                Children.Add(cpTag);

                var cpDot = new Ellipse
                {
                    Width = 9,
                    Height = 9,
                    Fill = purple,
                    Stroke = bg1,
                    StrokeThickness = 1.5,
                    ToolTip = $"Step #{s.StepIndex} COMPACTION\nBefore: {FormatUtil.Tokens(s.InputTokens)} → Summary: {FormatUtil.Tokens(s.OutputTokens)}",
                };
                SetLeft(cpDot, x - 4.5);
                SetTop(cpDot, y - 4.5);
                Children.Add(cpDot);
            }
            else
            {
                string sign = s.ContextDelta >= 0 ? "+" : "";
                var dot = new Ellipse
                {
                    Width = dotSize,
                    Height = dotSize,
                    Fill = cyan,
                    Stroke = bg1,
                    StrokeThickness = 1,
                    ToolTip = $"Step #{s.StepIndex} ({s.ModelDisplayName})\nTotal Context: {FormatUtil.Tokens(s.TotalContextTokens)} ({sign}{FormatUtil.Tokens(s.ContextDelta)})\nUncached In: {FormatUtil.Tokens(s.InputTokens)} · Cache: {FormatUtil.Tokens(s.CacheReadTokens)} ({s.CacheHitRate * 100:0}%)\nOutput: {FormatUtil.Tokens(s.OutputTokens)}",
                };
                SetLeft(dot, x - dotSize / 2);
                SetTop(dot, y - dotSize / 2);
                Children.Add(dot);
            }
        }

        // X-axis step markers
        var xIndices = steps.Count <= 3
            ? Enumerable.Range(0, steps.Count).ToArray()
            : new[] { 0, steps.Count / 2, steps.Count - 1 };
        foreach (int idx in xIndices.Distinct())
        {
            var lbl = new TextBlock
            {
                Text = $"#{steps[idx].StepIndex}",
                Foreground = fgMuted,
                FontSize = 10,
                FontFamily = new System.Windows.Media.FontFamily("Consolas"),
            };
            SetLeft(lbl, Math.Clamp(XFor(idx) - 12, padL, w - padR - 26));
            SetTop(lbl, h - 19);
            Children.Add(lbl);
        }
    }
}
