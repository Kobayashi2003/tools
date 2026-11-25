using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace UsageOrb.Platform;

/// <summary>
/// Generates crisp Obsidian Glass concentric dual-ring icons for WPF Window.Icon,
/// taskbar, and Windows notification tray without external binary asset dependencies.
/// </summary>
public static class AppIconFactory
{
    public static ImageSource CreateWindowIcon()
    {
        using var bmp = RenderDualRingBitmap(
            size: 64,
            outerPercent: 68,
            innerPercent: 84,
            outerColor: System.Drawing.Color.FromArgb(56, 189, 248),
            innerColor: System.Drawing.Color.FromArgb(52, 211, 153));

        IntPtr hBitmap = bmp.GetHbitmap();
        try
        {
            var source = Imaging.CreateBitmapSourceFromHBitmap(
                hBitmap,
                IntPtr.Zero,
                Int32Rect.Empty,
                BitmapSizeOptions.FromEmptyOptions());
            source.Freeze();
            return source;
        }
        finally
        {
            DeleteObject(hBitmap);
        }
    }

    public static Icon CreateTrayIcon(
        double contextPercent,
        double fiveHourRemainingPercent,
        System.Drawing.Color contextColor,
        System.Drawing.Color quotaColor)
    {
        using var bmp = RenderDualRingBitmap(
            size: 32,
            outerPercent: contextPercent,
            innerPercent: fiveHourRemainingPercent,
            outerColor: contextColor,
            innerColor: quotaColor);

        IntPtr hIcon = bmp.GetHicon();
        try
        {
            using var temp = Icon.FromHandle(hIcon);
            return (Icon)temp.Clone();
        }
        finally
        {
            NativeMethods.DestroyIcon(hIcon);
        }
    }

    private static Bitmap RenderDualRingBitmap(
        int size,
        double outerPercent,
        double innerPercent,
        System.Drawing.Color outerColor,
        System.Drawing.Color innerColor)
    {
        var bmp = new Bitmap(size, size);
        using var g = Graphics.FromImage(bmp);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
        g.Clear(System.Drawing.Color.Transparent);

        float pad = size * 0.06f;
        float bodyD = size - pad * 2f;

        // Matte obsidian disc with subtle specular rim
        using var bgBrush = new SolidBrush(System.Drawing.Color.FromArgb(250, 17, 20, 28));
        g.FillEllipse(bgBrush, pad, pad, bodyD, bodyD);

        using var rimPen = new System.Drawing.Pen(System.Drawing.Color.FromArgb(145, 72, 85, 112), Math.Max(1.0f, size * 0.025f));
        g.DrawEllipse(rimPen, pad, pad, bodyD, bodyD);

        // Outer ring (Context %)
        float outerStroke = Math.Max(2.6f, size * 0.095f);
        float outerInset = pad + outerStroke * 0.95f;
        float outerD = size - outerInset * 2f;

        using var outerTrack = new System.Drawing.Pen(System.Drawing.Color.FromArgb(52, 255, 255, 255), outerStroke);
        g.DrawEllipse(outerTrack, outerInset, outerInset, outerD, outerD);

        if (outerPercent > 0)
        {
            using var outerArc = new System.Drawing.Pen(outerColor, outerStroke) { StartCap = LineCap.Round, EndCap = LineCap.Round };
            g.DrawArc(outerArc, outerInset, outerInset, outerD, outerD, -90f, (float)(Math.Clamp(outerPercent, 4, 100) / 100.0 * 355.0));

        }

        // Inner ring (5-Hour Quota Remaining %)
        float innerStroke = Math.Max(2.0f, size * 0.072f);
        float innerInset = outerInset + outerStroke * 1.15f;
        float innerD = size - innerInset * 2f;
        if (innerD > 4f)
        {
            using var innerTrack = new System.Drawing.Pen(System.Drawing.Color.FromArgb(40, 255, 255, 255), innerStroke);
            g.DrawEllipse(innerTrack, innerInset, innerInset, innerD, innerD);

            if (innerPercent > 0)
            {
                using var innerArc = new System.Drawing.Pen(innerColor, innerStroke) { StartCap = LineCap.Round, EndCap = LineCap.Round };
                g.DrawArc(innerArc, innerInset, innerInset, innerD, innerD, -90f, (float)(Math.Clamp(innerPercent, 4, 100) / 100.0 * 355.0));
            }
        }

        // Crisp center dot
        float dotD = size * 0.14f;
        using var dotBrush = new SolidBrush(System.Drawing.Color.FromArgb(240, 244, 246, 250));
        g.FillEllipse(dotBrush, (size - dotD) / 2f, (size - dotD) / 2f, dotD, dotD);

        return bmp;
    }

    [System.Runtime.InteropServices.DllImport("gdi32.dll")]
    [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
    private static extern bool DeleteObject(IntPtr hObject);
}
