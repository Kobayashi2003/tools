using System.Globalization;
using System.Windows;
using System.Windows.Media;

namespace UsageOrb.UI.Controls;

/// <summary>
/// Obsidian Glass concentric dual-ring floating orb displaying active Context Window %
/// (outer arc), 5-Hour Quota Remaining % (inner arc), crisp centered percentage readout,
/// and a live emerald activity pulse dot.
/// </summary>
public sealed class OrbRingCanvas : FrameworkElement
{
    private double? _contextPercent;
    private double _fiveHourRemainingPercent;
    private bool _isActiveWriting;
    private bool _isHovered;
    private bool _isDark = true;
    private double _warnPercent = 70;
    private double _criticalPercent = 88;
    private double _quotaLowPercent = 20;

    public void UpdateMetrics(
        double? contextPercent,
        double fiveHourRemainingPercent,
        bool isActiveWriting,
        double warnPercent,
        double criticalPercent,
        double quotaLowPercent,
        bool isDark)
    {
        _contextPercent = contextPercent is double percent ? Math.Clamp(percent, 0, 100) : null;
        _fiveHourRemainingPercent = Math.Clamp(fiveHourRemainingPercent, 0, 100);
        _isActiveWriting = isActiveWriting;
        _warnPercent = warnPercent;
        _criticalPercent = criticalPercent;
        _quotaLowPercent = quotaLowPercent;
        _isDark = isDark;
        InvalidateVisual();
    }

    public void SetHovered(bool hovered)
    {
        if (_isHovered == hovered) return;
        _isHovered = hovered;
        InvalidateVisual();
    }

    protected override void OnRender(DrawingContext dc)
    {
        base.OnRender(dc);

        double size = Math.Min(ActualWidth, ActualHeight);
        if (size <= 4) return;

        double cx = ActualWidth / 2.0;
        double cy = ActualHeight / 2.0;
        var center = new System.Windows.Point(cx, cy);
        double outerRadius = (size / 2.0) - 2.0;

        // Soft ambient drop shadow
        var shadowBrush = new SolidColorBrush(_isDark
            ? System.Windows.Media.Color.FromArgb(115, 0, 0, 0)
            : System.Windows.Media.Color.FromArgb(45, 15, 23, 42));
        dc.DrawEllipse(shadowBrush, null, new System.Windows.Point(cx, cy + 1.2), outerRadius + 0.9, outerRadius + 0.9);

        // Matte glass orb disc with subtle specular border
        var fillColor = _isDark
            ? (_isHovered ? System.Windows.Media.Color.FromArgb(250, 24, 29, 41) : System.Windows.Media.Color.FromArgb(242, 16, 19, 27))
            : (_isHovered ? System.Windows.Media.Color.FromArgb(255, 255, 255, 255) : System.Windows.Media.Color.FromArgb(246, 250, 252, 255));
        var rimColor = _isDark
            ? (_isHovered ? System.Windows.Media.Color.FromArgb(190, 96, 112, 144) : System.Windows.Media.Color.FromArgb(135, 58, 68, 92))
            : (_isHovered ? System.Windows.Media.Color.FromArgb(200, 148, 163, 184) : System.Windows.Media.Color.FromArgb(150, 203, 213, 225));

        dc.DrawEllipse(
            new SolidColorBrush(fillColor),
            new System.Windows.Media.Pen(new SolidColorBrush(rimColor), 1.0),
            center,
            outerRadius,
            outerRadius);

        // Outer ring: Active Context Window %
        double outerStroke = Math.Max(2.2, size * 0.072);
        double outerRingR = outerRadius - outerStroke * 0.95 - 1.2;

        var trackColor = _isDark
            ? System.Windows.Media.Color.FromArgb(46, 255, 255, 255)
            : System.Windows.Media.Color.FromArgb(38, 15, 23, 42);
        dc.DrawEllipse(null, new System.Windows.Media.Pen(new SolidColorBrush(trackColor), outerStroke), center, outerRingR, outerRingR);

        if (_contextPercent is double percent && percent > 0.5)
        {
            DrawArc(dc, center, outerRingR, -90.0, Math.Max(8.0, percent / 100.0 * 356.0), ResolveContextColor(percent), outerStroke);
        }

        // Inner ring: 5-Hour Quota Remaining %
        double innerStroke = Math.Max(1.7, size * 0.052);
        double ringGap = Math.Max(1.4, size * 0.036);
        double innerRingR = outerRingR - (outerStroke + innerStroke) / 2.0 - ringGap;

        if (innerRingR > size * 0.16)
        {
            var innerTrackColor = _isDark
                ? System.Windows.Media.Color.FromArgb(30, 255, 255, 255)
                : System.Windows.Media.Color.FromArgb(26, 15, 23, 42);
            dc.DrawEllipse(null, new System.Windows.Media.Pen(new SolidColorBrush(innerTrackColor), innerStroke), center, innerRingR, innerRingR);

            var quotaColor = ResolveRemainingColor(_fiveHourRemainingPercent);
            if (_fiveHourRemainingPercent > 0.5)
            {
                DrawArc(dc, center, innerRingR, -90.0, Math.Max(8.0, _fiveHourRemainingPercent / 100.0 * 356.0), quotaColor, innerStroke);
            }
        }

        // Crisp center readout
        bool showPctSign = size >= 44;
        string label = _contextPercent is double current ? current.ToString("0") + (showPctSign ? "%" : "") : "—";
        double fontSize = showPctSign ? Math.Max(8.5, size * 0.215) : Math.Max(8.5, size * 0.255);
        var textColor = _isDark
            ? System.Windows.Media.Color.FromRgb(244, 246, 250)
            : System.Windows.Media.Color.FromRgb(15, 23, 42);

        var dpi = VisualTreeHelper.GetDpi(this).PixelsPerDip;
        var ft = new FormattedText(
            label,
            CultureInfo.InvariantCulture,
            System.Windows.FlowDirection.LeftToRight,
            new Typeface(new System.Windows.Media.FontFamily("Segoe UI"), FontStyles.Normal, FontWeights.Bold, FontStretches.Normal),
            fontSize,
            new SolidColorBrush(textColor),
            dpi);

        dc.DrawText(ft, new System.Windows.Point(cx - ft.Width / 2.0, cy - ft.Height / 2.0 - 0.3));

        // Top-right emerald pulse dot when Antigravity session updated recently
        if (_isActiveWriting)
        {
            double dotR = Math.Max(2.3, size * 0.068);
            var dotPt = new System.Windows.Point(cx + outerRadius * 0.68, cy - outerRadius * 0.68);
            dc.DrawEllipse(
                new SolidColorBrush(System.Windows.Media.Color.FromArgb(90, 52, 211, 153)),
                null,
                dotPt,
                dotR + 1.6,
                dotR + 1.6);
            dc.DrawEllipse(
                new SolidColorBrush(System.Windows.Media.Color.FromRgb(52, 211, 153)),
                new System.Windows.Media.Pen(new SolidColorBrush(fillColor), 1.2),
                dotPt,
                dotR,
                dotR);
        }
    }

    private System.Windows.Media.Color ResolveContextColor(double pct)
    {
        if (pct >= _criticalPercent) return _isDark ? System.Windows.Media.Color.FromRgb(248, 113, 113) : System.Windows.Media.Color.FromRgb(220, 38, 38);
        if (pct >= _warnPercent) return _isDark ? System.Windows.Media.Color.FromRgb(251, 191, 36) : System.Windows.Media.Color.FromRgb(217, 119, 6);
        return _isDark ? System.Windows.Media.Color.FromRgb(56, 189, 248) : System.Windows.Media.Color.FromRgb(2, 132, 199);
    }

    private System.Windows.Media.Color ResolveRemainingColor(double remPct)
    {
        if (remPct <= Math.Min(15, _quotaLowPercent)) return _isDark ? System.Windows.Media.Color.FromRgb(248, 113, 113) : System.Windows.Media.Color.FromRgb(220, 38, 38);
        if (remPct <= Math.Max(42, _quotaLowPercent)) return _isDark ? System.Windows.Media.Color.FromRgb(251, 191, 36) : System.Windows.Media.Color.FromRgb(217, 119, 6);
        return _isDark ? System.Windows.Media.Color.FromRgb(52, 211, 153) : System.Windows.Media.Color.FromRgb(5, 150, 105);
    }

    private static void DrawArc(
        DrawingContext dc,
        System.Windows.Point center,
        double radius,
        double startAngleDeg,
        double sweepAngleDeg,
        System.Windows.Media.Color color,
        double thickness)
    {
        double startRad = startAngleDeg * Math.PI / 180.0;
        double endRad = (startAngleDeg + sweepAngleDeg) * Math.PI / 180.0;

        var startPt = new System.Windows.Point(
            center.X + radius * Math.Cos(startRad),
            center.Y + radius * Math.Sin(startRad));
        var endPt = new System.Windows.Point(
            center.X + radius * Math.Cos(endRad),
            center.Y + radius * Math.Sin(endRad));

        bool isLargeArc = sweepAngleDeg > 180.0;
        var figure = new PathFigure { StartPoint = startPt, IsClosed = false };
        figure.Segments.Add(new ArcSegment(
            endPt,
            new System.Windows.Size(radius, radius),
            0,
            isLargeArc,
            SweepDirection.Clockwise,
            isStroked: true));

        var geometry = new PathGeometry([figure]);
        var pen = new System.Windows.Media.Pen(new SolidColorBrush(color), thickness)
        {
            StartLineCap = PenLineCap.Round,
            EndLineCap = PenLineCap.Round,
        };
        dc.DrawGeometry(null, pen, geometry);
    }
}
