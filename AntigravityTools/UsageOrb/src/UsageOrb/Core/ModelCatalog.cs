using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace UsageOrb.Core;

public static partial class ModelCatalog
{
    private sealed record ModelRule(
        Regex Pattern,
        string Family,
        QuotaGroupId QuotaGroup,
        long ContextWindow,
        string ContextWindowSource,
        string BaseName,
        ModelPricing Pricing);

    private static readonly IReadOnlyList<ModelRule> Rules =
    [
        new(new Regex("^gemini-4-neon", RegexOptions.IgnoreCase | RegexOptions.Compiled),
            "gemini-4", QuotaGroupId.GeminiPro, 524_288, "documented", "Gemini 4 Neon",
            new ModelPricing(2.5, 0.25, 15.0)),
        new(new Regex("^gemini-4-carbon", RegexOptions.IgnoreCase | RegexOptions.Compiled),
            "gemini-4", QuotaGroupId.GeminiPro, 1_048_576, "documented", "Gemini 4 Carbon",
            new ModelPricing(4.0, 0.4, 20.0)),
        new(new Regex("^gemini-4-argon", RegexOptions.IgnoreCase | RegexOptions.Compiled),
            "gemini-4", QuotaGroupId.GeminiPro, 1_048_576, "documented", "Gemini 4 Argon",
            new ModelPricing(2.0, 0.2, 12.0)),
        new(new Regex("^gemini-4-hydrogen", RegexOptions.IgnoreCase | RegexOptions.Compiled),
            "gemini-4", QuotaGroupId.GeminiPro, 1_048_576, "documented", "Gemini 4 Hydrogen",
            new ModelPricing(0.5, 0.05, 3.0)),
        new(new Regex("^gemini-pro-orchestrator", RegexOptions.IgnoreCase | RegexOptions.Compiled),
            "gemini-4", QuotaGroupId.GeminiPro, 524_288, "documented", "Orchestrator",
            new ModelPricing(1.5, 0.15, 9.0)),
        new(new Regex("^gemini-3\\.8-flash", RegexOptions.IgnoreCase | RegexOptions.Compiled),
            "gemini-3", QuotaGroupId.GeminiFlash, 1_048_576, "documented", "Gemini 3.8 Flash",
            new ModelPricing(0.15, 0.015, 0.6)),
        new(new Regex("^gemini-3\\.[67]-flash", RegexOptions.IgnoreCase | RegexOptions.Compiled),
            "gemini-3", QuotaGroupId.GeminiFlash, 1_048_576, "documented", "Gemini 3 Flash",
            new ModelPricing(0.15, 0.015, 0.6)),
        new(new Regex("^gemini-3\\.1-pro", RegexOptions.IgnoreCase | RegexOptions.Compiled),
            "gemini-3", QuotaGroupId.GeminiPro, 1_048_576, "documented", "Gemini 3.1 Pro",
            new ModelPricing(1.25, 0.125, 10.0)),
        new(new Regex("flash", RegexOptions.IgnoreCase | RegexOptions.Compiled),
            "gemini-3", QuotaGroupId.GeminiFlash, 1_048_576, "estimated", "Gemini Flash",
            new ModelPricing(0.15, 0.015, 0.6)),
        new(new Regex("^claude-opus-5-5", RegexOptions.IgnoreCase | RegexOptions.Compiled),
            "claude", QuotaGroupId.PartnerClaudeGpt, 200_000, "documented", "Claude Opus 5.5",
            new ModelPricing(15.0, 1.5, 75.0)),
        new(new Regex("^claude-sonnet-5-5", RegexOptions.IgnoreCase | RegexOptions.Compiled),
            "claude", QuotaGroupId.PartnerClaudeGpt, 200_000, "documented", "Claude Sonnet 5.5",
            new ModelPricing(3.0, 0.3, 15.0)),
        new(new Regex("^claude-opus", RegexOptions.IgnoreCase | RegexOptions.Compiled),
            "claude", QuotaGroupId.PartnerClaudeGpt, 200_000, "documented", "Claude Opus",
            new ModelPricing(15.0, 1.5, 75.0)),
        new(new Regex("^claude-sonnet", RegexOptions.IgnoreCase | RegexOptions.Compiled),
            "claude", QuotaGroupId.PartnerClaudeGpt, 200_000, "documented", "Claude Sonnet",
            new ModelPricing(3.0, 0.3, 15.0)),
        new(new Regex("^gpt-oss-120b", RegexOptions.IgnoreCase | RegexOptions.Compiled),
            "gpt", QuotaGroupId.PartnerClaudeGpt, 131_072, "estimated", "GPT-OSS 120B",
            new ModelPricing(1.0, 0.1, 4.0)),
        new(new Regex("^gpt-", RegexOptions.IgnoreCase | RegexOptions.Compiled),
            "gpt", QuotaGroupId.PartnerClaudeGpt, 131_072, "estimated", "GPT",
            new ModelPricing(2.0, 0.2, 8.0)),
    ];

    public static string GetQuotaGroupLabel(QuotaGroupId id) => id switch
    {
        QuotaGroupId.GeminiPro => "Gemini Pro / Reasoning",
        QuotaGroupId.GeminiFlash => "Gemini Flash",
        QuotaGroupId.PartnerClaudeGpt => "Claude & GPT",
        _ => "Other Models",
    };

    public static QuotaGroupId InferQuotaGroupFromBucketId(string bucketId)
    {
        var lower = bucketId.ToLowerInvariant();
        if (lower.Contains("flash")) return QuotaGroupId.GeminiFlash;
        if (lower.StartsWith("3p-") || lower.Contains("claude") || lower.Contains("gpt") || lower.Contains("partner") || lower.Contains("anthropic"))
            return QuotaGroupId.PartnerClaudeGpt;
        if (lower.Contains("gemini") || lower.Contains("neon") || lower.Contains("carbon") ||
            lower.Contains("argon") || lower.Contains("hydrogen") || lower.Contains("pro"))
            return QuotaGroupId.GeminiPro;
        return QuotaGroupId.Other;
    }

    public static string FormatQuotaBucketLabel(string bucketId)
    {
        var spaced = BucketSeparatorRegex().Replace(bucketId, " ").Trim();
        var titled = CultureInfo.InvariantCulture.TextInfo.ToTitleCase(spaced.ToLowerInvariant());
        return titled
            .Replace("5h", "5-Hour", StringComparison.OrdinalIgnoreCase)
            .Replace("7d", "7-Day", StringComparison.OrdinalIgnoreCase)
            .Replace("Gpt", "GPT", StringComparison.Ordinal)
            .Replace("Ai", "AI", StringComparison.Ordinal)
            .Replace("G1", "AI", StringComparison.Ordinal);
    }

    public static ModelSpec Resolve(string? rawModelId, long? liveContextWindow = null)
    {
        var id = string.IsNullOrWhiteSpace(rawModelId) ? "unknown" : rawModelId.Trim();
        var normalized = WhitespaceRegex().Replace(id.ToLowerInvariant(), "-");
        var effort = DetectEffort(id);
        var hasLive = liveContextWindow.HasValue && liveContextWindow.Value > 0;

        foreach (var rule in Rules)
        {
            if (rule.Pattern.IsMatch(normalized) || rule.Pattern.IsMatch(id))
            {
                var effortSuffix = FormatEffortLabel(effort);
                var display = id.Contains(' ')
                    ? id
                    : (string.IsNullOrEmpty(effortSuffix) ? rule.BaseName : $"{rule.BaseName} ({effortSuffix})");

                return new ModelSpec(
                    id,
                    display,
                    rule.Family,
                    rule.QuotaGroup,
                    GetQuotaGroupLabel(rule.QuotaGroup),
                    effort,
                    hasLive ? liveContextWindow!.Value : rule.ContextWindow,
                    hasLive ? "live" : rule.ContextWindowSource,
                    rule.Pricing);
            }
        }

        return new ModelSpec(
            id,
            string.Equals(id, "unknown", StringComparison.OrdinalIgnoreCase) ? "Unknown Model" : id,
            "other",
            QuotaGroupId.Other,
            GetQuotaGroupLabel(QuotaGroupId.Other),
            effort,
            hasLive ? liveContextWindow!.Value : 524_288,
            hasLive ? "live" : "estimated",
            new ModelPricing(1.0, 0.1, 5.0));
    }

    public static double EstimateCostUsd(string modelId, long inputTokens, long cacheReadTokens, long outputTokens)
    {
        var spec = Resolve(modelId);
        return (Math.Max(0, inputTokens) / 1_000_000.0) * spec.Pricing.InputPerMillionUsd +
               (Math.Max(0, cacheReadTokens) / 1_000_000.0) * spec.Pricing.CacheReadPerMillionUsd +
               (Math.Max(0, outputTokens) / 1_000_000.0) * spec.Pricing.OutputPerMillionUsd;
    }

    public static double EstimateCacheSavingsUsd(string modelId, long cacheReadTokens)
    {
        var spec = Resolve(modelId);
        var priceDelta = Math.Max(0, spec.Pricing.InputPerMillionUsd - spec.Pricing.CacheReadPerMillionUsd);
        return (Math.Max(0, cacheReadTokens) / 1_000_000.0) * priceDelta;
    }

    private static string? DetectEffort(string modelId)
    {
        var lower = modelId.ToLowerInvariant();
        if (EffortXHighRegex().IsMatch(lower)) return "xhigh";
        if (EffortMaxRegex().IsMatch(lower)) return "max";
        if (EffortHighRegex().IsMatch(lower)) return "high";
        if (EffortMediumRegex().IsMatch(lower)) return "medium";
        if (EffortLowRegex().IsMatch(lower)) return "low";
        return null;
    }

    private static string FormatEffortLabel(string? effort) => effort switch
    {
        "xhigh" => "Extra High",
        "max" => "Max",
        "high" => "High",
        "medium" => "Medium",
        "low" => "Low",
        _ => "",
    };

    private sealed class DiskModelsCache
    {
        public DateTimeOffset FetchedAt { get; set; }
        public List<AvailableAccountModel> Models { get; set; } = [];
    }

    private static readonly object CacheLock = new();
    private static DiskModelsCache? _memoryCache;
    private static Task<IReadOnlyList<AvailableAccountModel>>? _inflightTask;
    private static readonly TimeSpan CacheTtl = TimeSpan.FromMinutes(30);

    public static IReadOnlyList<AvailableAccountModel> GetCachedAccountModels()
    {
        lock (CacheLock)
        {
            if (_memoryCache is null)
            {
                _memoryCache = ReadDiskCache();
            }

            return _memoryCache?.Models ?? [];
        }
    }

    public static Task<IReadOnlyList<AvailableAccountModel>> RefreshAccountModelsAsync(bool force = false)
    {
        lock (CacheLock)
        {
            if (_memoryCache is null)
            {
                _memoryCache = ReadDiskCache();
            }

            if (!force && _memoryCache is not null && DateTimeOffset.UtcNow - _memoryCache.FetchedAt < CacheTtl)
            {
                return Task.FromResult<IReadOnlyList<AvailableAccountModel>>(_memoryCache.Models);
            }

            if (_inflightTask is not null)
            {
                return _inflightTask;
            }

            _inflightTask = FetchFromAgyCliAsync();
            return _inflightTask;
        }
    }

    private static async Task<IReadOnlyList<AvailableAccountModel>> FetchFromAgyCliAsync()
    {
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = "agy",
                Arguments = "models",
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };

            using var proc = Process.Start(psi);
            if (proc is null) return GetCachedAccountModels();

            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            var stdout = await proc.StandardOutput.ReadToEndAsync(cts.Token).ConfigureAwait(false);
            await proc.WaitForExitAsync(cts.Token).ConfigureAwait(false);

            var list = new List<AvailableAccountModel>();
            foreach (var rawLine in stdout.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries))
            {
                var line = rawLine.Trim();
                if (line.Length == 0 || line.StartsWith("Fetching", StringComparison.OrdinalIgnoreCase)) continue;
                var parts = line.Split('\t');
                if (parts.Length < 2) continue;

                var id = parts[0].Trim();
                var display = parts[1].Trim();
                var spec = Resolve(id);
                list.Add(new AvailableAccountModel(
                    id,
                    display,
                    spec.QuotaGroup,
                    spec.QuotaGroupLabel,
                    spec.ContextWindow,
                    spec.Effort));
            }

            if (list.Count > 0)
            {
                var cache = new DiskModelsCache { FetchedAt = DateTimeOffset.UtcNow, Models = list };
                lock (CacheLock)
                {
                    _memoryCache = cache;
                }

                WriteDiskCache(cache);
                return list;
            }

            return GetCachedAccountModels();
        }
        catch
        {
            return GetCachedAccountModels();
        }
        finally
        {
            lock (CacheLock)
            {
                _inflightTask = null;
            }
        }
    }

    private static DiskModelsCache? ReadDiskCache()
    {
        try
        {
            var path = AntigravityPaths.GetModelsCacheFilePath();
            if (!File.Exists(path)) return null;
            return JsonSerializer.Deserialize<DiskModelsCache>(File.ReadAllText(path));
        }
        catch
        {
            return null;
        }
    }

    private static void WriteDiskCache(DiskModelsCache cache)
    {
        try
        {
            var path = AntigravityPaths.GetModelsCacheFilePath();
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllText(path, JsonSerializer.Serialize(cache));
        }
        catch
        {
            // Ignore non-critical disk cache write errors
        }
    }

    [GeneratedRegex("[_-]+")]
    private static partial Regex BucketSeparatorRegex();

    [GeneratedRegex("\\s+")]
    private static partial Regex WhitespaceRegex();

    [GeneratedRegex("(^|[-_(\\s])xhigh($|[)\\s])|\\bextra\\b")]
    private static partial Regex EffortXHighRegex();

    [GeneratedRegex("(^|[-_(\\s])max($|[)\\s])")]
    private static partial Regex EffortMaxRegex();

    [GeneratedRegex("(^|[-_(\\s])high($|[)\\s])")]
    private static partial Regex EffortHighRegex();

    [GeneratedRegex("(^|[-_(\\s])medium($|[)\\s])")]
    private static partial Regex EffortMediumRegex();

    [GeneratedRegex("(^|[-_(\\s])low($|[)\\s])")]
    private static partial Regex EffortLowRegex();
}
