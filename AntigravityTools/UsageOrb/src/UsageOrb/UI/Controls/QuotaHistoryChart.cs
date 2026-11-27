using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Shapes;
using UsageOrb.Core;

namespace UsageOrb.UI.Controls;

/// <summary>
/// Multi-series sparkline chart showing recorded live quota remaining % over time.
/// </summary>
public sealed class QuotaHistoryChart : Canvas
{
    private IReadOnlyList<QuotaHistoryPoint> _history = [];

    private static readonly System.Windows.Media.Color[] Palette =
    [
        System.Windows.Media.Color.FromRgb(96, 165, 250),
        System.Windows.Media.Color.FromRgb(52, 211, 153),
        System.Windows.Media.Color.FromRgb(251, 191, 36),
        System.Windows.Media.Color.FromRgb(167, 139, 250),
        System.Windows.Media.Color.FromRgb(244, 114, 182),
    ];

    public QuotaHistoryChart()
    {
        ClipToBounds = true;
        SizeChanged += (_, _) => Redraw();
    }

    public void Update(IReadOnlyList<QuotaHistoryPoint> history)
    {
        _history = history;
        Redraw();
    }

    private void Redraw()
    {
        Children.Clear();
        double w = ActualWidth;
        double h = ActualHeight;
        if (w < 80 || h < 50 || _history.Count < 2) return;

        var fgMuted = TryFindResource("FgMutedBrush") as System.Windows.Media.Brush ?? System.Windows.Media.Brushes.Gray;
        var border = TryFindResource("BorderSubtleBrush") as System.Windows.Media.Brush ?? System.Windows.Media.Brushes.DimGray;

        var bucketIds = _history
            .SelectMany(p => p.RemainingFractions.Keys)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
        if (bucketIds.Count == 0) return;

        const double padL = 38;
        const double padR = 12;
        const double padT = 10;
        const double padB = 18;
        double plotW = Math.Max(20, w - padL - padR);
        double plotH = Math.Max(20, h - padT - padB);

        foreach (int pct in new[] { 0, 50, 100 })
        {
            double y = padT + plotH - (pct / 100.0) * plotH;
            Children.Add(new Line
            {
                X1 = padL,
                Y1 = y,
                X2 = w - padR,
                Y2 = y,
                Stroke = border,
                StrokeThickness = 1,
                StrokeDashArray = pct == 0 ? null : new DoubleCollection([3, 3]),
            });
            var lbl = new TextBlock
            {
                Text = $"{pct}%",
                Foreground = fgMuted,
                FontSize = 9.5,
                FontFamily = new System.Windows.Media.FontFamily("Consolas"),
                Width = padL - 5,
                TextAlignment = TextAlignment.Right,
            };
            SetLeft(lbl, 0);
            SetTop(lbl, y - 6.5);
            Children.Add(lbl);
        }

        for (int sIdx = 0; sIdx < bucketIds.Count; sIdx++)
        {
            var id = bucketIds[sIdx];
            var brush = new SolidColorBrush(Palette[sIdx % Palette.Length]);
            var pts = new PointCollection();

            for (int i = 0; i < _history.Count; i++)
            {
                if (_history[i].RemainingFractions.TryGetValue(id, out var fraction))
                {
                    double x = padL + (double)i / (_history.Count - 1) * plotW;
                    double y = padT + plotH - Math.Clamp(fraction, 0, 1) * plotH;
                    pts.Add(new System.Windows.Point(x, y));
                }
            }

            if (pts.Count >= 2)
            {
                Children.Add(new Polyline
                {
                    Points = pts,
                    Stroke = brush,
                    StrokeThickness = 2.0,
                    ToolTip = ModelCatalog.FormatQuotaBucketLabel(id),
                });
            }
        }
    }
}
