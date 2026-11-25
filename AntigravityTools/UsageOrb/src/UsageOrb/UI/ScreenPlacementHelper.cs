using System.Windows;
using System.Windows.Forms;
using System.Windows.Media;

namespace UsageOrb.UI;

internal static class ScreenPlacementHelper
{
    /// <summary>
    /// Positions a popup window (hover card or click popover) neatly adjacent to the floating widget,
    /// opening upward by default (Codex-style) and flipping/clamping automatically to stay inside the
    /// active monitor's working area at any DPI.
    /// </summary>
    public static void PlaceNearOrb(Window popup, Window orb, double gapDip = 10)
    {
        var dpi = VisualTreeHelper.GetDpi(orb);
        double scaleX = dpi.DpiScaleX > 0 ? dpi.DpiScaleX : 1.0;
        double scaleY = dpi.DpiScaleY > 0 ? dpi.DpiScaleY : 1.0;

        int centerPxX = (int)Math.Round((orb.Left + orb.Width / 2.0) * scaleX);
        int centerPxY = (int)Math.Round((orb.Top + orb.Height / 2.0) * scaleY);
        var screen = Screen.FromPoint(new System.Drawing.Point(centerPxX, centerPxY));
        var wa = screen.WorkingArea;

        double waLeft = wa.Left / scaleX;
        double waTop = wa.Top / scaleY;
        double waRight = wa.Right / scaleX;
        double waBottom = wa.Bottom / scaleY;

        double popW = popup.ActualWidth > 10 ? popup.ActualWidth : (double.IsNaN(popup.Width) ? 300 : popup.Width);
        double popH = popup.ActualHeight > 10 ? popup.ActualHeight : (double.IsNaN(popup.Height) ? 200 : popup.Height);

        double top = orb.Top - popH - gapDip;
        if (top < waTop + 8)
        {
            top = orb.Top + orb.Height + gapDip;
        }

        bool onRightHalf = (orb.Left + orb.Width / 2.0) > (waLeft + waRight) / 2.0;
        double left = onRightHalf
            ? (orb.Left + orb.Width) - popW
            : orb.Left;

        left = Math.Clamp(left, waLeft + 8, Math.Max(waLeft + 8, waRight - popW - 8));
        top = Math.Clamp(top, waTop + 8, Math.Max(waTop + 8, waBottom - popH - 8));

        popup.Left = left;
        popup.Top = top;
    }

    public static System.Windows.Media.Brush BrushForContext(double pct, double warn, double critical, FrameworkElement scope)
    {
        string key = pct >= critical ? "DangerBrush" : (pct >= warn ? "WarnBrush" : "CyanBrush");
        return scope.TryFindResource(key) as System.Windows.Media.Brush ?? System.Windows.Media.Brushes.DeepSkyBlue;
    }

    public static System.Windows.Media.Brush BrushForUsage(double pct, double warn, double critical, FrameworkElement scope)
    {
        string key = pct >= critical ? "DangerBrush" : (pct >= warn ? "WarnBrush" : "OkBrush");
        return scope.TryFindResource(key) as System.Windows.Media.Brush ?? System.Windows.Media.Brushes.MediumSeaGreen;
    }

    public static System.Windows.Media.Brush BrushForRemaining(double? remPct, double low, FrameworkElement scope)
    {
        string key = remPct is null ? "FgMutedBrush" : remPct <= Math.Min(15, low) ? "DangerBrush" : (remPct <= Math.Max(42, low) ? "WarnBrush" : "OkBrush");
        return scope.TryFindResource(key) as System.Windows.Media.Brush ?? System.Windows.Media.Brushes.MediumSeaGreen;
    }

    public static (System.Windows.Media.Brush Bg, System.Windows.Media.Brush Border) HeroTintForRemaining(
        double? remPct,
        double low,
        FrameworkElement scope)
    {
        string bgKey;
        string bdKey;
        if (remPct is null)
        {
            bgKey = "BgSecondaryBrush";
            bdKey = "BorderPrimaryBrush";
        }
        else if (remPct <= Math.Min(15, low))
        {
            bgKey = "HeroDangerBgBrush";
            bdKey = "HeroDangerBorderBrush";
        }
        else if (remPct <= Math.Max(42, low))
        {
            bgKey = "HeroWarnBgBrush";
            bdKey = "HeroWarnBorderBrush";
        }
        else
        {
            bgKey = "HeroOkBgBrush";
            bdKey = "HeroOkBorderBrush";
        }

        var bg = scope.TryFindResource(bgKey) as System.Windows.Media.Brush ?? System.Windows.Media.Brushes.Black;
        var bd = scope.TryFindResource(bdKey) as System.Windows.Media.Brush ?? System.Windows.Media.Brushes.DimGray;
        return (bg, bd);
    }
}
