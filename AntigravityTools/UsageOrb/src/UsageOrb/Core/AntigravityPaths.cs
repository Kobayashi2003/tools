using System.IO;

namespace UsageOrb.Core;

public sealed record BrainRoot(AntigravitySurface Surface, string BrainDir);

public sealed record DiscoveredTranscript(
    string ConversationId,
    AntigravitySurface Surface,
    string TranscriptPath,
    long LastWriteUtcTicks,
    long SizeBytes);

public static class AntigravityPaths
{
    public static string GetGeminiHomeDir()
    {
        var overrideDir = Environment.GetEnvironmentVariable("USAGEORB_GEMINI_HOME");
        if (!string.IsNullOrWhiteSpace(overrideDir)) return overrideDir;
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".gemini");
    }

    public static string GetAppDataDir()
    {
        var overrideDir = Environment.GetEnvironmentVariable("USAGEORB_DATA_DIR");
        if (!string.IsNullOrWhiteSpace(overrideDir)) return overrideDir;
        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "AntigravityUsageOrb");
    }

    public static string GetSettingsFilePath() => Path.Combine(GetAppDataDir(), "settings.json");

    public static IReadOnlyList<BrainRoot> GetExistingBrainRoots() =>
        GetBrainRoots().Where(c => Directory.Exists(c.BrainDir)).ToList();

    public static IReadOnlyList<BrainRoot> GetBrainRoots()
    {
        var geminiHome = GetGeminiHomeDir();
        var candidates = new List<BrainRoot>
        {
            new(AntigravitySurface.App, Path.Combine(geminiHome, "antigravity", "brain")),
            new(AntigravitySurface.Ide, Path.Combine(geminiHome, "antigravity-ide", "brain")),
        };

        var customAppData = Environment.GetEnvironmentVariable("ANTIGRAVITY_APP_DATA_DIR");
        if (!string.IsNullOrWhiteSpace(customAppData))
        {
            var customBrain = Path.Combine(customAppData, "brain");
            if (!candidates.Any(c => string.Equals(Path.GetFullPath(c.BrainDir), Path.GetFullPath(customBrain), StringComparison.OrdinalIgnoreCase)))
            {
                candidates.Insert(0, new BrainRoot(AntigravitySurface.App, customBrain));
            }
        }

        return candidates;
    }

    public static (IReadOnlyList<string> Roots, IReadOnlyList<DiscoveredTranscript> Transcripts) DiscoverTranscripts()
    {
        var roots = GetExistingBrainRoots();
        var byId = new Dictionary<string, DiscoveredTranscript>(StringComparer.OrdinalIgnoreCase);

        foreach (var root in roots)
        {
            IEnumerable<string> dirs;
            try
            {
                dirs = Directory.EnumerateDirectories(root.BrainDir);
            }
            catch
            {
                continue;
            }

            foreach (var dir in dirs)
            {
                var convId = Path.GetFileName(dir);
                if (string.IsNullOrEmpty(convId) ||
                    convId.StartsWith('.') ||
                    string.Equals(convId, "tempmediaStorage", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                var logsDir = Path.Combine(dir, ".system_generated", "logs");
                var compactPath = Path.Combine(logsDir, "transcript.jsonl");
                var fullPath = Path.Combine(logsDir, "transcript_full.jsonl");

                FileInfo? info;
                try
                {
                    var compact = new FileInfo(compactPath);
                    var full = new FileInfo(fullPath);
                    info = compact.Exists && compact.Length > 0 ? compact : null;
                    if (full.Exists && full.Length > 0 &&
                        (info is null || full.LastWriteTimeUtc > info.LastWriteTimeUtc.AddSeconds(1)))
                    {
                        info = full;
                    }
                }
                catch
                {
                    continue;
                }
                if (info is null) continue;

                var item = new DiscoveredTranscript(
                    convId,
                    root.Surface,
                    info.FullName,
                    info.LastWriteTimeUtc.Ticks,
                    info.Length);

                if (!byId.TryGetValue(convId, out var existing) || item.LastWriteUtcTicks > existing.LastWriteUtcTicks)
                {
                    byId[convId] = item;
                }
            }
        }

        var ordered = byId.Values
            .OrderByDescending(t => t.LastWriteUtcTicks)
            .ToList();

        return (roots.Select(r => r.BrainDir).ToList(), ordered);
    }
}
