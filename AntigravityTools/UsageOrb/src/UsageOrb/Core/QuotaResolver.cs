namespace UsageOrb.Core;

public static class QuotaResolver
{
    public static (QuotaWindowSummary FiveHour, QuotaWindowSummary Weekly) Resolve(
        DashboardSnapshot snapshot,
        AppSettings settings,
        DateTimeOffset? now = null,
        SessionDetail? session = null)
    {
        var current = now ?? DateTimeOffset.UtcNow;
        var model = ModelCatalog.Resolve(session?.PrimaryModelId);
        var candidates = snapshot.QuotaBuckets
            .Where(b => !b.Disabled && b.RemainingFraction.HasValue && b.GetLiveResetInSeconds(current) is not 0)
            .ToList();

        var fiveHour = FindBucket(candidates, model, WindowKey.FiveHours, ["5h", "5-hour", "5-hours"]);
        var weekly = FindBucket(candidates, model, WindowKey.SevenDays, ["week", "weekly", "7d", "7-day", "7-days"]);

        return (
            Summarize(fiveHour, snapshot.Windows[WindowKey.FiveHours], settings.FiveHourTokenBudget ?? settings.FiveHourEstBaselineTokens, current),
            Summarize(weekly, snapshot.Windows[WindowKey.SevenDays], settings.WeeklyTokenBudget ?? settings.WeeklyEstBaselineTokens, current));
    }

    private static QuotaBucketStatus? FindBucket(
        IEnumerable<QuotaBucketStatus> buckets, ModelSpec model, WindowKey window, string[] periods)
    {
        return buckets
            .Where(b =>
            {
                if (b.Window is { } period) return period == window;
                var id = "-" + b.Id.ToLowerInvariant().Replace('_', '-') + "-";
                return periods.Any(p => id.Contains("-" + p + "-", StringComparison.Ordinal));
            })
            .Select(bucket => (Bucket: bucket, Rank: MatchModel(bucket, model)))
            .Where(candidate => candidate.Rank > 0)
            .OrderByDescending(candidate => candidate.Rank)
            .ThenBy(candidate => candidate.Bucket.RemainingFraction)
            .Select(candidate => candidate.Bucket)
            .FirstOrDefault();
    }

    private static int MatchModel(QuotaBucketStatus bucket, ModelSpec model)
    {
        bool sharedGemini = string.Equals(bucket.PoolName, "Gemini Models", StringComparison.OrdinalIgnoreCase) ||
            bucket.Id is "gemini-5h" or "gemini-weekly";
        bool sharedPartner = string.Equals(bucket.PoolName, "Claude and GPT models", StringComparison.OrdinalIgnoreCase) ||
            bucket.Id.StartsWith("3p-", StringComparison.OrdinalIgnoreCase);

        if (sharedGemini) return model.QuotaGroup is QuotaGroupId.GeminiPro or QuotaGroupId.GeminiFlash or QuotaGroupId.Other ? 3 : 0;
        if (sharedPartner) return model.QuotaGroup == QuotaGroupId.PartnerClaudeGpt ? 3 : model.QuotaGroup == QuotaGroupId.Other ? 2 : 0;
        if (!string.IsNullOrWhiteSpace(bucket.PoolName))
        {
            return model.DisplayName.Equals(bucket.PoolName, StringComparison.OrdinalIgnoreCase) ||
                model.DisplayName.StartsWith(bucket.PoolName + " (", StringComparison.OrdinalIgnoreCase) ? 4 : 0;
        }
        if (bucket.QuotaGroup == model.QuotaGroup && model.QuotaGroup != QuotaGroupId.Other) return 2;
        return bucket.QuotaGroup == QuotaGroupId.Other || model.QuotaGroup == QuotaGroupId.Other ? 1 : 0;
    }

    private static QuotaWindowSummary Summarize(
        QuotaBucketStatus? bucket, WindowAnalytics usage, long baseline, DateTimeOffset now)
    {
        double? estimated = baseline > 0
            ? Math.Clamp(100.0 - (double)usage.TotalTokens / baseline * 100.0, 0, 100)
            : null;
        bool cached = bucket?.IsStale(now) == true;
        return new QuotaWindowSummary(
            bucket?.RemainingFraction * 100 ?? estimated,
            IsLive: bucket is not null,
            bucket is not null ? (cached ? "Cached" : bucket.WillExhaustBeforeReset == true ? "At risk" : "Live")
                : estimated is not null ? "Est." : "Unavailable",
            bucket?.GetLiveResetInSeconds(now),
            bucket?.ResetTime,
            usage.TotalTokens,
            usage.BurnRateTokensPerHour,
            usage.Invocations,
            usage.SessionsCount,
            baseline,
            cached ? null : bucket?.WillExhaustBeforeReset,
            cached ? null : bucket?.ProjectedExhaustionTime,
            bucket?.PoolName ?? bucket?.Label);
    }
}
