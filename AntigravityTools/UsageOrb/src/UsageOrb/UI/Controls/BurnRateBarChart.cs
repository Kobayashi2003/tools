using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Shapes;
using UsageOrb.Core;

namespace UsageOrb.UI.Controls;

/// <summary>
/// Obsidian Glass interactive stacked bar chart displaying Cache Read, Uncached Input,
/// and Output token volumes across hourly or daily buckets.
/// </summary>
public sealed class BurnRateBarChart : Canvas
{
    private IReadOnlyList<TimeBucketPoint> _buckets = [];

    private static readonly SolidColorBrush CacheBrush = new(System.Windows.Media.Color.FromRgb(34, 197, 138));
    private static readonly SolidColorBrush InputBrush = new(System.Windows.Media.Color.FromRgb(96, 165, 250));
    private static readonly SolidColorBrush OutputBrush = new(System.Windows.Media.Color.FromRgb(245, 179, 51));

    public BurnRateBarChart()
    {
        ClipToBounds = true;
        SizeChanged += (_, _) => Redraw();
    }

    public void Update(IReadOnlyList<TimeBucketPoint> buckets)
    {
        _buckets = buckets;
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

        if (_buckets.Count == 0)
        {
            var empty = new TextBlock
            {
                Text = "No usage recorded in the selected window.",
                Foreground = fgMuted,
                FontSize = 12,
            };
            SetLeft(empty, Math.Max(12, w / 2 - 120));
            SetTop(empty, h / 2 - 10);
            Children.Add(empty);
            return;
        }

        const double padL = 54;
        const double padR = 14;
        const double padT = 10;
        const double padB = 26;
        double plotW = Math.Max(20, w - padL - padR);
        double plotH = Math.Max(20, h - padT - padB);

        long maxTot = Math.Max(1_000L, _buckets.Max(b => b.TotalTokens));

        for (int t = 0; t <= 3; t++)
        {
            double val = maxTot * t / 3.0;
            double y = padT + plotH - (val / maxTot) * plotH;
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

        double slotW = plotW / _buckets.Count;
        double barW = Math.Clamp(slotW * 0.52, 6, 38);
        int labelStep = _buckets.Count > 18 ? 4 : (_buckets.Count > 9 ? 2 : 1);

        for (int i = 0; i < _buckets.Count; i++)
        {
            var b = _buckets[i];
            double x = padL + i * slotW + (slotW - barW) / 2.0;

            double cacheH = (double)b.CacheReadTokens / maxTot * plotH;
            double inH = (double)b.InputTokens / maxTot * plotH;
            double outH = (double)b.OutputTokens / maxTot * plotH;

            string tip = $"{b.Label}\nTotal: {FormatUtil.Tokens(b.TotalTokens)} ({b.Invocations} calls)\nCache Read: {FormatUtil.Tokens(b.CacheReadTokens)}\nUncached Input: {FormatUtil.Tokens(b.InputTokens)}\nOutput: {FormatUtil.Tokens(b.OutputTokens)}\nEst. Ref Spend: {FormatUtil.Usd(b.EstimatedCostUsd)}";

            var segments = new List<(double H, System.Windows.Media.Brush Fill)>();
            if (cacheH > 0) segments.Add((Math.Max(2.0, cacheH), CacheBrush));
            if (inH > 0) segments.Add((Math.Max(2.0, inH), InputBrush));
            if (outH > 0) segments.Add((Math.Max(2.0, outH), OutputBrush));

            double totalH = Math.Min(plotH, segments.Sum(s => s.H));
            if (totalH > 0 && segments.Count > 0)
            {
                // Rounded-top clipped host matching Obsidian Glass bars
                var barStack = new Grid { Width = barW, Height = totalH, ToolTip = tip };
                double sumRaw = segments.Sum(s => s.H);
                for (int sIdx = segments.Count - 1; sIdx >= 0; sIdx--)
                {
                    barStack.RowDefinitions.Add(new RowDefinition { Height = new GridLength(segments[sIdx].H / sumRaw, GridUnitType.Star) });
                    var segBorder = new Border
                    {
                        Background = segments[sIdx].Fill,
                        Margin = sIdx == 0 ? new Thickness(0) : new Thickness(0, 0, 0, 0.5),
                    };
                    Grid.SetRow(segBorder, segments.Count - 1 - sIdx);
                    barStack.Children.Add(segBorder);
                }

                var clipped = new Border
                {
                    Width = barW,
                    Height = totalH,
                    CornerRadius = new CornerRadius(3.5, 3.5, 1, 1),
                    ClipToBounds = true,
                    Child = barStack,
                    ToolTip = tip,
                };
                SetLeft(clipped, x);
                SetTop(clipped, padT + plotH - totalH);
                Children.Add(clipped);
            }

            if (i % labelStep == 0 || i == _buckets.Count - 1)
            {
                var lbl = new TextBlock
                {
                    Text = b.Label,
                    Foreground = fgMuted,
                    FontSize = 10,
                    FontFamily = new System.Windows.Media.FontFamily("Consolas"),
                    Width = Math.Max(38, slotW),
                    TextAlignment = TextAlignment.Center,
                };
                SetLeft(lbl, x + barW / 2.0 - lbl.Width / 2.0);
                SetTop(lbl, h - 19);
                Children.Add(lbl);
            }
        }
    }
}
