namespace UsageOrb.Core;

public enum AntigravitySurface
{
    App,
    Ide,
    Unknown,
}

public enum QuotaGroupId
{
    GeminiPro,
    GeminiFlash,
    PartnerClaudeGpt,
    Other,
}

public enum WindowKey
{
    FiveHours,
    TwentyFourHours,
    SevenDays,
    ThirtyDays,
    All,
}

public enum FloatingWidgetShape
{
    CircularOrb,
    CompactPill,
}

public enum OrbDockMode
{
    FollowAntigravity,
    FreeFloat,
}

public enum OrbAnchorCorner
{
    BottomLeft,
    BottomRight,
    TopLeft,
    TopRight,
}

public enum ThemePreference
{
    System,
    Dark,
    Light,
}

public sealed record ModelPricing(
    double InputPerMillionUsd,
    double CacheReadPerMillionUsd,
    double OutputPerMillionUsd);

public sealed record ModelSpec(
    string Id,
    string DisplayName,
    QuotaGroupId QuotaGroup,
    string QuotaGroupLabel,
    string? Effort,
    long ContextWindow,
    ModelPricing Pricing);

public sealed record QuotaHistoryPoint(
    DateTimeOffset CapturedAt,
    IReadOnlyDictionary<string, double> RemainingFractions);

public sealed record QuotaBucketStatus(
    string Id,
    string Label,
    QuotaGroupId QuotaGroup,
    double? RemainingFraction,
    double? RemainingAmount,
    DateTimeOffset? ResetTime,
    double? InitialResetInSeconds,
    bool Disabled,
    DateTimeOffset CapturedAt,
    double? BurnRatePerHour,
    DateTimeOffset? ProjectedExhaustionTime,
    bool? WillExhaustBeforeReset)
{
    internal string? PoolName { get; init; }
    internal WindowKey? Window { get; init; }

    public long? GetLiveResetInSeconds(DateTimeOffset now)
    {
        if (ResetTime.HasValue)
        {
            return Math.Max(0L, (long)(ResetTime.Value - now).TotalSeconds);
        }

        if (InitialResetInSeconds.HasValue)
        {
            var elapsed = (now - CapturedAt).TotalSeconds;
            return Math.Max(0L, (long)(InitialResetInSeconds.Value - elapsed));
        }

        return null;
    }

    public bool IsStale(DateTimeOffset now) => (now - CapturedAt).TotalMinutes > (PoolName is null ? 30 : 3);
}

public sealed class AppSettings
{
    public FloatingWidgetShape WidgetShape { get; set; } = FloatingWidgetShape.CircularOrb;
    public OrbDockMode DockMode { get; set; } = OrbDockMode.FollowAntigravity;
    public OrbAnchorCorner AnchorCorner { get; set; } = OrbAnchorCorner.BottomLeft;
    public double AnchorOffsetX { get; set; } = 14;
    public double AnchorOffsetY { get; set; } = 16;
    public double FreeFloatX { get; set; } = -1;
    public double FreeFloatY { get; set; } = -1;
    public int OrbSizePx { get; set; } = 40;
    public double IdleOpacity { get; set; } = 0.88;
    public ThemePreference Theme { get; set; } = ThemePreference.System;
    public bool OrbVisible { get; set; } = true;
    public bool ShowTrayIcon { get; set; } = true;
    public bool ShowTaskbarButton { get; set; } = true;
    public bool RegisterStartMenuShortcut { get; set; }
    public bool StartWithWindows { get; set; }
    public bool FollowAntigravityLifecycle { get; set; }
    public string? AntigravityProxy { get; set; }
    public double ContextWarnPercent { get; set; } = 70;
    public double ContextCriticalPercent { get; set; } = 88;
    public double QuotaLowPercent { get; set; } = 20;
    public long FiveHourEstBaselineTokens { get; set; }
    public long WeeklyEstBaselineTokens { get; set; }
    public bool QuotaBaselinesSaved { get; set; }
    public long? FiveHourTokenBudget { get; set; }
    public long? WeeklyTokenBudget { get; set; }

    public AppSettings Clone() => (AppSettings)MemberwiseClone();
}

public sealed record QuotaWindowSummary(
    double? RemainingPercent,
    bool IsLive,
    string StatusBadge,
    long? ResetInSeconds,
    long WindowTokens,
    double TokensPerHour,
    int SessionsCount,
    long EstimatedBaselineTokens,
    bool? WillExhaustBeforeReset,
    string? BucketLabel)
{
    public string FormatPercent(string format = "0") =>
        RemainingPercent is double percent ? $"{percent.ToString(format)}%" : "—";
}

public sealed record ContextCategoryItem(
    string Key,
    string Label,
    long Tokens,
    double PercentageOfContext,
    double PercentageOfWindow,
    string ColorHex);

public sealed record ToolContextStat(
    string Name,
    int CallCount,
    int ErrorCount,
    long EstimatedArgTokens,
    long EstimatedOutputTokens,
    long EstimatedTotalTokens,
    double ShareOfToolTokens,
    long MaxSingleOutputTokens);

public sealed record CompactionEvent(
    int StepIndex,
    DateTimeOffset CreatedAt,
    long BeforeTokens,
    long SummaryTokens,
    long FreedTokens,
    double CompressionRatio);

public sealed record StepTelemetry(
    int StepIndex,
    DateTimeOffset CreatedAt,
    string Type,
    string ModelId,
    string ModelDisplayName,
    long InputTokens,
    long CacheReadTokens,
    long TotalContextTokens,
    long ContextDelta,
    long OutputTokens,
    double CacheHitRate,
    IReadOnlyList<string> ToolNames,
    int ToolCallCount,
    bool HasError,
    double EstimatedCostUsd);

public sealed record HeaviestStepInfo(
    int StepIndex,
    string Type,
    string Label,
    long EstimatedTokens,
    DateTimeOffset CreatedAt);

public sealed record SubagentLink(
    string ConversationId,
    string Role,
    string TypeName,
    string RequestedModel,
    int StepIndex,
    long TotalInputTokens,
    long TotalCacheReadTokens,
    long TotalOutputTokens,
    long PeakContextTokens,
    double EstimatedCostUsd,
    int Invocations,
    bool FoundTranscript);

public sealed record RolledUpTotals(
    long InputTokens,
    long CacheReadTokens,
    long OutputTokens,
    int Invocations,
    double EstimatedCostUsd)
{
    public long TotalTokens => InputTokens + CacheReadTokens + OutputTokens;
}

public sealed record SessionDetail(
    string ConversationId,
    AntigravitySurface Surface,
    string Title,
    string? Workspace,
    DateTimeOffset LastActiveAt,
    bool IsRecentlyWriting,
    bool IsSubagent,
    string PrimaryModelId,
    string PrimaryModelDisplayName,
    long ContextWindowSize,
    long CurrentContextTokens,
    long ProjectedNextContextTokens,
    double ContextUsedPercent,
    long ContextRemainingTokens,
    bool Exceeds200kTokens,
    long PeakContextTokens,
    long LatestInputTokens,
    long LatestCacheReadTokens,
    long LatestOutputTokens,
    long LastContextDelta,
    long TotalInputTokens,
    long TotalCacheReadTokens,
    long TotalOutputTokens,
    long TotalBilledTokens,
    double OverallCacheHitRate,
    int UserTurns,
    int ModelInvocations,
    int ToolCallCount,
    int CompactionCount,
    double EstimatedCostUsd,
    IReadOnlyList<ContextCategoryItem> Categories,
    long CheckpointBufferTokens,
    IReadOnlyList<CompactionEvent> Compactions,
    IReadOnlyList<StepTelemetry> Steps,
    IReadOnlyList<ToolContextStat> Tools,
    IReadOnlyList<HeaviestStepInfo> HeaviestSteps,
    IReadOnlyList<SubagentLink> Subagents,
    RolledUpTotals RolledUpTotals);

public sealed record QuotaGroupUsage(
    QuotaGroupId GroupId,
    string Label,
    IReadOnlyList<string> Models,
    int Invocations,
    int UserTurns,
    int SessionsCount,
    long InputTokens,
    long CacheReadTokens,
    long OutputTokens,
    long TotalTokens,
    double CacheHitRate,
    double EstimatedCostUsd,
    double ShareOfTokens,
    double BurnRateTokensPerHour,
    double BurnRateCallsPerHour);

public sealed record ModelUsageAggregate(
    string ModelId,
    string DisplayName,
    QuotaGroupId QuotaGroup,
    string QuotaGroupLabel,
    long ContextWindow,
    int Invocations,
    int SessionsCount,
    long InputTokens,
    long CacheReadTokens,
    long OutputTokens,
    long TotalTokens,
    double CacheHitRate,
    long AvgContextTokens,
    long PeakContextTokens,
    long AvgOutputTokens,
    double EstimatedCostUsd,
    double ShareOfTokens);

public sealed record TimeBucketPoint(
    string Label,
    DateTimeOffset Start,
    long InputTokens,
    long CacheReadTokens,
    long OutputTokens,
    int Invocations,
    double EstimatedCostUsd)
{
    public long TotalTokens => InputTokens + CacheReadTokens + OutputTokens;
}

public sealed record WindowAnalytics(
    WindowKey Window,
    string Label,
    DateTimeOffset? Start,
    DateTimeOffset End,
    double HoursSpan,
    int SessionsCount,
    int Invocations,
    int UserTurns,
    int Compactions,
    int Errors,
    long InputTokens,
    long CacheReadTokens,
    long OutputTokens,
    long TotalTokens,
    double CacheHitRate,
    double EstimatedCostUsd,
    double CacheSavedUsd,
    double BurnRateTokensPerHour,
    double BurnRateCallsPerHour,
    IReadOnlyList<QuotaGroupUsage> ByQuotaGroup,
    IReadOnlyList<ModelUsageAggregate> ByModel,
    IReadOnlyList<ToolContextStat> TopTools,
    IReadOnlyList<TimeBucketPoint> Timeline);

public sealed record UsageInsight(
    string Severity,
    string Code,
    string Title,
    string Detail,
    string? Recommendation);

public sealed record DashboardSnapshot(
    DateTimeOffset GeneratedAt,
    string? ActiveConversationId,
    IReadOnlyList<QuotaBucketStatus> QuotaBuckets,
    IReadOnlyList<QuotaHistoryPoint> QuotaHistory,
    IReadOnlyDictionary<WindowKey, WindowAnalytics> Windows,
    double? SprintVsWeeklyPaceRatio,
    IReadOnlyList<SessionDetail> Sessions,
    SessionDetail? ActiveSession,
    IReadOnlyList<UsageInsight> Insights,
    IReadOnlyList<string> ScannedRoots)
{
    public DateTimeOffset? DesktopQuotaLastSeenAt { get; init; }
}
