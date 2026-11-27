using System.Globalization;

namespace UsageOrb.Core;

public static class FormatUtil
{
    public static string Tokens(double value)
    {
        if (!double.IsFinite(value)) return "0";
        var abs = Math.Abs(value);
        var sign = value < 0 ? "-" : "";
        if (abs >= 1_000_000_000) return $"{sign}{(abs / 1_000_000_000).ToString("0.00", CultureInfo.InvariantCulture)}B";
        if (abs >= 1_000_000) return $"{sign}{(abs / 1_000_000).ToString("0.00", CultureInfo.InvariantCulture)}M";
        if (abs >= 10_000) return $"{sign}{(abs / 1_000).ToString("0.0", CultureInfo.InvariantCulture)}K";
        if (abs >= 1_000) return $"{sign}{(abs / 1_000).ToString("0.00", CultureInfo.InvariantCulture)}K";
        return $"{sign}{Math.Round(abs).ToString("0", CultureInfo.InvariantCulture)}";
    }

    public static string TokensCompact(double value)
    {
        if (!double.IsFinite(value)) return "0";
        var abs = Math.Abs(value);
        var sign = value < 0 ? "-" : "";
        if (abs >= 1_000_000_000)
        {
            double b = abs / 1_000_000_000;
            return $"{sign}{(b % 1 == 0 ? b.ToString("0", CultureInfo.InvariantCulture) : b.ToString("0.0", CultureInfo.InvariantCulture))}B";
        }

        if (abs >= 1_000_000)
        {
            double m = abs / 1_000_000;
            return $"{sign}{(m >= 10 || m % 1 == 0 ? Math.Round(m).ToString("0", CultureInfo.InvariantCulture) : m.ToString("0.0", CultureInfo.InvariantCulture))}M";
        }

        if (abs >= 1_000)
        {
            double k = abs / 1_000;
            return $"{sign}{(k >= 10 || k % 1 == 0 ? Math.Round(k).ToString("0", CultureInfo.InvariantCulture) : k.ToString("0.0", CultureInfo.InvariantCulture))}K";
        }

        return $"{sign}{Math.Round(abs).ToString("0", CultureInfo.InvariantCulture)}";
    }

    public static long? ParseTokenShorthand(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        var s = text.Trim().Replace(",", "").Replace("_", "").ToUpperInvariant();
        double mult = 1.0;
        if (s.EndsWith("B")) { mult = 1_000_000_000.0; s = s[..^1]; }
        else if (s.EndsWith("M")) { mult = 1_000_000.0; s = s[..^1]; }
        else if (s.EndsWith("K")) { mult = 1_000.0; s = s[..^1]; }

        if (double.TryParse(s.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out var val) && val > 0 && double.IsFinite(val))
        {
            return (long)Math.Round(val * mult);
        }

        return null;
    }

    public static string Exact(long value) => value.ToString("N0", CultureInfo.InvariantCulture);

    public static string Usd(double value)
    {
        if (!double.IsFinite(value) || value <= 0) return "$0.00";
        if (value < 0.01) return "$" + value.ToString("0.0000", CultureInfo.InvariantCulture);
        return "$" + value.ToString("0.00", CultureInfo.InvariantCulture);
    }

    public static string Duration(long? totalSeconds)
    {
        if (!totalSeconds.HasValue) return "—";
        var s = Math.Max(0L, totalSeconds.Value);
        var d = s / 86400;
        var h = (s % 86400) / 3600;
        var m = (s % 3600) / 60;
        var r = s % 60;
        if (d > 0) return $"{d}d {h}h";
        if (h > 0) return $"{h}h {m}m";
        if (m > 0) return $"{m}m {r}s";
        return $"{r}s";
    }

    public static string RelativeTime(DateTimeOffset timestamp, DateTimeOffset? now = null)
    {
        var current = now ?? DateTimeOffset.UtcNow;
        var sec = Math.Max(0L, (long)(current - timestamp).TotalSeconds);
        if (sec < 60) return $"{sec}s ago";
        if (sec < 3600) return $"{sec / 60}m ago";
        if (sec < 86400) return $"{sec / 3600}h ago";
        return $"{sec / 86400}d ago";
    }

    public static string SurfaceTag(AntigravitySurface surface) => surface switch
    {
        AntigravitySurface.App => "APP",
        AntigravitySurface.Ide => "IDE",
        _ => "—",
    };

    public static string WindowShort(WindowKey key) => key switch
    {
        WindowKey.FiveHours => "5H",
        WindowKey.TwentyFourHours => "24H",
        WindowKey.SevenDays => "7D",
        WindowKey.ThirtyDays => "30D",
        WindowKey.All => "ALL",
        _ => "7D",
    };
}
