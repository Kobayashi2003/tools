using System;
using System.Globalization;

namespace QuickLook.Plugin.FolderViewer;

internal static class Format
{
    private static readonly string[] Units = { "KB", "MB", "GB", "TB", "PB", "EB" };

    /// <summary>Binary units with three significant digits, as File Explorer shows them.</summary>
    public static string Size(long bytes, IFormatProvider? provider = null)
    {
        provider ??= CultureInfo.CurrentCulture;
        if (bytes < 1024)
            return bytes.ToString(provider) + " B";

        double value = bytes;
        var unit = -1;
        do
        {
            value /= 1024;
            unit++;
        }
        while (value >= 1024 && unit < Units.Length - 1);

        var pattern = value >= 100 ? "0" : value >= 10 ? "0.#" : "0.##";
        return value.ToString(pattern, provider) + " " + Units[unit];
    }

    public static string Count(long count) => count.ToString("N0", CultureInfo.CurrentCulture);
}
