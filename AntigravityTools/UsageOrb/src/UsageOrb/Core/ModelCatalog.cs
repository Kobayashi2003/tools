using System.Globalization;
using System.Text.RegularExpressions;

namespace UsageOrb.Core;

public static partial class ModelCatalog
{
    private sealed record ModelRule(
        Regex Pattern,
        QuotaGroupId QuotaGroup,
        long ContextWindow,
        string BaseName,
        ModelPricing Pricing);

    private static readonly IReadOnlyList<ModelRule> Rules =
    [
        new(new Regex("^gemini-4-neon", RegexOptions.IgnoreCase | RegexOptions.Compiled),
            QuotaGroupId.GeminiPro, 524_288, "Gemini 4 Neon",
            new ModelPricing(2.5, 0.25, 15.0)),
        new(new Regex("^gemini-4-carbon", RegexOptions.IgnoreCase | RegexOptions.Compiled),
            QuotaGroupId.GeminiPro, 1_048_576, "Gemini 4 Carbon",
            new ModelPricing(4.0, 0.4, 20.0)),
        new(new Regex("^gemini-4-argon", RegexOptions.IgnoreCase | RegexOptions.Compiled),
            QuotaGroupId.GeminiPro, 1_048_576, "Gemini 4 Argon",
            new ModelPricing(2.0, 0.2, 12.0)),
        new(new Regex("^gemini-4-hydrogen", RegexOptions.IgnoreCase | RegexOptions.Compiled),
            QuotaGroupId.GeminiPro, 1_048_576, "Gemini 4 Hydrogen",
            new ModelPricing(0.5, 0.05, 3.0)),
        new(new Regex("^gemini-pro-orchestrator", RegexOptions.IgnoreCase | RegexOptions.Compiled),
            QuotaGroupId.GeminiPro, 524_288, "Orchestrator",
            new ModelPricing(1.5, 0.15, 9.0)),
        new(new Regex("^gemini-3\\.8-flash", RegexOptions.IgnoreCase | RegexOptions.Compiled),
            QuotaGroupId.GeminiFlash, 1_048_576, "Gemini 3.8 Flash",
            new ModelPricing(0.15, 0.015, 0.6)),
        new(new Regex("^gemini-3\\.[67]-flash", RegexOptions.IgnoreCase | RegexOptions.Compiled),
            QuotaGroupId.GeminiFlash, 1_048_576, "Gemini 3 Flash",
            new ModelPricing(0.15, 0.015, 0.6)),
        new(new Regex("^gemini-3\\.1-pro", RegexOptions.IgnoreCase | RegexOptions.Compiled),
            QuotaGroupId.GeminiPro, 1_048_576, "Gemini 3.1 Pro",
            new ModelPricing(1.25, 0.125, 10.0)),
        new(new Regex("flash", RegexOptions.IgnoreCase | RegexOptions.Compiled),
            QuotaGroupId.GeminiFlash, 1_048_576, "Gemini Flash",
            new ModelPricing(0.15, 0.015, 0.6)),
        new(new Regex("^claude-opus-5-5", RegexOptions.IgnoreCase | RegexOptions.Compiled),
            QuotaGroupId.PartnerClaudeGpt, 200_000, "Claude Opus 5.5",
            new ModelPricing(15.0, 1.5, 75.0)),
        new(new Regex("^claude-sonnet-5-5", RegexOptions.IgnoreCase | RegexOptions.Compiled),
            QuotaGroupId.PartnerClaudeGpt, 200_000, "Claude Sonnet 5.5",
            new ModelPricing(3.0, 0.3, 15.0)),
        new(new Regex("^claude-opus", RegexOptions.IgnoreCase | RegexOptions.Compiled),
            QuotaGroupId.PartnerClaudeGpt, 200_000, "Claude Opus",
            new ModelPricing(15.0, 1.5, 75.0)),
        new(new Regex("^claude-sonnet", RegexOptions.IgnoreCase | RegexOptions.Compiled),
            QuotaGroupId.PartnerClaudeGpt, 200_000, "Claude Sonnet",
            new ModelPricing(3.0, 0.3, 15.0)),
        new(new Regex("^gpt-oss-120b", RegexOptions.IgnoreCase | RegexOptions.Compiled),
            QuotaGroupId.PartnerClaudeGpt, 131_072, "GPT-OSS 120B",
            new ModelPricing(1.0, 0.1, 4.0)),
        new(new Regex("^gpt-", RegexOptions.IgnoreCase | RegexOptions.Compiled),
            QuotaGroupId.PartnerClaudeGpt, 131_072, "GPT",
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

    public static ModelSpec Resolve(string? rawModelId)
    {
        var id = string.IsNullOrWhiteSpace(rawModelId) ? "unknown" : rawModelId.Trim();
        var normalized = WhitespaceRegex().Replace(id.ToLowerInvariant(), "-");
        var effort = DetectEffort(id);

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
                    rule.QuotaGroup,
                    GetQuotaGroupLabel(rule.QuotaGroup),
                    effort,
                    rule.ContextWindow,
                    rule.Pricing);
            }
        }

        return new ModelSpec(
            id,
            string.Equals(id, "unknown", StringComparison.OrdinalIgnoreCase) ? "Unknown Model" : id,
            QuotaGroupId.Other,
            GetQuotaGroupLabel(QuotaGroupId.Other),
            effort,
            524_288,
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
