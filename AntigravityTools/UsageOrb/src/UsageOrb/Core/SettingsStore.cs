using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace UsageOrb.Core;

internal static class SettingsStore
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        WriteIndented = true,
        Converters = { new JsonStringEnumConverter() },
    };

    private static AppSettings? ReadSettings(string path)
    {
        try
        {
            if (!File.Exists(path)) return null;
            using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            return JsonSerializer.Deserialize<AppSettings>(fs, JsonOptions);
        }
        catch
        {
            return null;
        }
    }

    private static void WriteSettings(string path, AppSettings settings)
    {
        var dir = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(dir))
        {
            Directory.CreateDirectory(dir);
        }

        var tmp = $"{path}.{Environment.ProcessId}.{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}.tmp";
        var json = JsonSerializer.Serialize(settings, JsonOptions);
        File.WriteAllText(tmp, json);

        try
        {
            File.Move(tmp, path, overwrite: true);
        }
        catch
        {
            try
            {
                File.Copy(tmp, path, overwrite: true);
            }
            finally
            {
                try { File.Delete(tmp); } catch { /* ignore cleanup error */ }
            }
        }
    }

    public static AppSettings LoadSettings()
    {
        var loaded = ReadSettings(AntigravityPaths.GetSettingsFilePath()) ?? new AppSettings();
        if (!loaded.QuotaBaselinesSaved)
        {
            // Earlier builds populated these values even when the user never set a budget.
            if (loaded.FiveHourEstBaselineTokens == 80_000_000) loaded.FiveHourEstBaselineTokens = 0;
            if (loaded.WeeklyEstBaselineTokens == 500_000_000) loaded.WeeklyEstBaselineTokens = 0;
        }
        NormalizeSettings(loaded);
        return loaded;
    }

    public static AppSettings SaveSettings(AppSettings settings)
    {
        var copy = settings.Clone();
        NormalizeSettings(copy);
        WriteSettings(AntigravityPaths.GetSettingsFilePath(), copy);
        return copy;
    }

    private static void NormalizeSettings(AppSettings s)
    {
        s.OrbSizePx = s.OrbSizePx is 32 or 40 or 48 ? s.OrbSizePx : 40;
        s.IdleOpacity = Math.Clamp(s.IdleOpacity, 0.35, 1.0);
        s.ContextWarnPercent = Math.Clamp(s.ContextWarnPercent, 10, 99);
        s.ContextCriticalPercent = Math.Clamp(s.ContextCriticalPercent, Math.Max(20, s.ContextWarnPercent + 1), 100);
        s.QuotaLowPercent = Math.Clamp(s.QuotaLowPercent, 1, 90);
        s.QuotaBaselinesSaved = true;
        s.FiveHourEstBaselineTokens = s.FiveHourEstBaselineTokens <= 0
            ? 0
            : Math.Clamp(s.FiveHourEstBaselineTokens, 1_000_000, 10_000_000_000);
        s.WeeklyEstBaselineTokens = s.WeeklyEstBaselineTokens <= 0
            ? 0
            : Math.Clamp(s.WeeklyEstBaselineTokens, 5_000_000, 100_000_000_000);
        if (s.FiveHourTokenBudget is <= 0) s.FiveHourTokenBudget = null;
        if (s.WeeklyTokenBudget is <= 0) s.WeeklyTokenBudget = null;
    }
}
