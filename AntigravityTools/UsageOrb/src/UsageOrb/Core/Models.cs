using System.Text.Json.Serialization;

namespace UsageOrb.Core;

public enum AntigravitySurface
{
    App,
    Cli,
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
    string Family,
    QuotaGroupId QuotaGroup,
    string QuotaGroupLabel,
    string? Effort,
    long ContextWindow,
    string ContextWindowSource,
    ModelPricing Pricing);

public sealed record AvailableAccountModel(
    string Id,
    string DisplayName,
    QuotaGroupId QuotaGroup,
    string QuotaGroupLabel,
    long ContextWindow,
    string? Effort);

public sealed class RawStatusLineQuotaBucket
{
    [JsonPropertyName("remaining_fraction")]
    public double? RemainingFraction { get; set; }

    [JsonPropertyName("remaining_amount")]
    public double? RemainingAmount { get; set; }

    [JsonPropertyName("reset_time")]
    public string? ResetTime { get; set; }

    [JsonPropertyName("reset_in_seconds")]
    public double? ResetInSeconds { get; set; }

    [JsonPropertyName("disabled")]
    public bool? Disabled { get; set; }

    [JsonIgnore]
    internal string? PoolName { get; init; }

    [JsonIgnore]
    internal string? DisplayLabel { get; init; }

    [JsonIgnore]
    internal WindowKey? Window { get; init; }
}

public sealed class RawStatusLineModel
{
    [JsonPropertyName("id")]
    public string? Id { get; set; }

    [JsonPropertyName("display_name")]
    public string? DisplayName { get; set; }

    [JsonPropertyName("effort")]
    public string? Effort { get; set; }
}

public sealed class RawStatusLineWorkspace
{
    [JsonPropertyName("current_dir")]
    public string? CurrentDir { get; set; }

    [JsonPropertyName("project_dir")]
    public string? ProjectDir { get; set; }
}

public sealed class RawStatusLineCurrentUsage
{
    [JsonPropertyName("input_tokens")]
    public long? InputTokens { get; set; }

    [JsonPropertyName("output_tokens")]
    public long? OutputTokens { get; set; }

    [JsonPropertyName("cache_creation_input_tokens")]
    public long? CacheCreationInputTokens { get; set; }

    [JsonPropertyName("cache_read_input_tokens")]
    public long? CacheReadInputTokens { get; set; }
}

public sealed class RawStatusLineContextWindow
{
    [JsonPropertyName("total_input_tokens")]
    public long? TotalInputTokens { get; set; }

    [JsonPropertyName("total_output_tokens")]
    public long? TotalOutputTokens { get; set; }

    [JsonPropertyName("context_window_size")]
    public long? ContextWindowSize { get; set; }

    [JsonPropertyName("used_percentage")]
    public double? UsedPercentage { get; set; }

    [JsonPropertyName("remaining_percentage")]
    public double? RemainingPercentage { get; set; }

    [JsonPropertyName("current_usage")]
    public RawStatusLineCurrentUsage? CurrentUsage { get; set; }

    public double? GetUsedPercentage()
    {
        var reported = UsedPercentage ?? (RemainingPercentage is { } remaining ? 100 - remaining : (double?)null);
        if (reported is double percent && double.IsFinite(percent)) return Math.Clamp(percent, 0, 100);
        if (ContextWindowSize is > 0 && CurrentUsage is { } usage)
        {
            long input = (usage.InputTokens ?? 0) + (usage.CacheReadInputTokens ?? 0) + (usage.CacheCreationInputTokens ?? 0);
            return Math.Clamp((double)input / ContextWindowSize.Value * 100, 0, 100);
        }
        return null;
    }
}

public sealed class RawStatusLineCost
{
    [JsonPropertyName("total_usd")]
    public double? TotalUsd { get; set; }

    [JsonPropertyName("subagent_usd")]
    public double? SubagentUsd { get; set; }

    [JsonPropertyName("estimated")]
    public bool? Estimated { get; set; }
}

public sealed class RawStatusLineSandbox
{
    [JsonPropertyName("enabled")]
    public bool? Enabled { get; set; }
}

public sealed class RawStatusLineSubagent
{
    [JsonPropertyName("name")]
    public string? Name { get; set; }

    [JsonPropertyName("role")]
    public string? Role { get; set; }

    [JsonPropertyName("status")]
    public string? Status { get; set; }
}

public sealed class RawStatusLinePayload
{
    [JsonPropertyName("cwd")]
    public string? Cwd { get; set; }

    [JsonPropertyName("session_id")]
    public string? SessionId { get; set; }

    [JsonPropertyName("conversation_id")]
    public string? ConversationId { get; set; }

    [JsonPropertyName("conversation_title")]
    public string? ConversationTitle { get; set; }

    [JsonPropertyName("transcript_path")]
    public string? TranscriptPath { get; set; }

    [JsonPropertyName("model")]
    public RawStatusLineModel? Model { get; set; }

    [JsonPropertyName("workspace")]
    public RawStatusLineWorkspace? Workspace { get; set; }

    [JsonPropertyName("version")]
    public string? Version { get; set; }

    [JsonPropertyName("context_window")]
    public RawStatusLineContextWindow? ContextWindow { get; set; }

    [JsonPropertyName("exceeds_200k_tokens")]
    public bool? Exceeds200kTokens { get; set; }

    [JsonPropertyName("quota")]
    public Dictionary<string, RawStatusLineQuotaBucket>? Quota { get; set; }

    [JsonPropertyName("agent_state")]
    public string? AgentState { get; set; }

    [JsonPropertyName("cycle_mode")]
    public string? CycleMode { get; set; }

    [JsonPropertyName("sandbox")]
    public RawStatusLineSandbox? Sandbox { get; set; }

    [JsonPropertyName("subagents")]
    public List<RawStatusLineSubagent>? Subagents { get; set; }

    [JsonPropertyName("artifact_count")]
    public int? ArtifactCount { get; set; }

    [JsonPropertyName("plan_tier")]
    public string? PlanTier { get; set; }

    [JsonPropertyName("email")]
    public string? Email { get; set; }

    [JsonPropertyName("task_count")]
    public int? TaskCount { get; set; }

    [JsonPropertyName("terminal_width")]
    public int? TerminalWidth { get; set; }

    [JsonPropertyName("cost")]
    public RawStatusLineCost? Cost { get; set; }
}

public sealed class CapturedStatusLine
{
    public DateTimeOffset CapturedAt { get; set; }
    public RawStatusLinePayload Payload { get; set; } = new();
}

public sealed class QuotaHistoryBucketSample
{
    public double? RemainingFraction { get; set; }
    public double? RemainingAmount { get; set; }
}

public sealed class QuotaHistoryPoint
{
    public DateTimeOffset CapturedAt { get; set; }
    public Dictionary<string, QuotaHistoryBucketSample> Buckets { get; set; } = new();
}

public sealed class StatusLineStateFile
{
    public int Version { get; set; } = 1;
    public DateTimeOffset UpdatedAt { get; set; }
    public CapturedStatusLine? Latest { get; set; }
    public CapturedStatusLine? LatestQuota { get; set; }
    public Dictionary<string, CapturedStatusLine> ByConversation { get; set; } = new();
    public List<QuotaHistoryPoint> QuotaHistory { get; set; } = [];
}

public sealed record QuotaBucketStatus(
    string Id,
    string Label,
    QuotaGroupId QuotaGroup,
    double? RemainingFraction,
    double? UsedFraction,
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
    public bool StartWithWindows { get; set; } = false;
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
    DateTimeOffset? ResetTime,
    long WindowTokens,
    double TokensPerHour,
    int Invocations,
    int SessionsCount,
    long EstimatedBaselineTokens,
    bool? WillExhaustBeforeReset,
    DateTimeOffset? ProjectedExhaustionTime,
    string? BucketLabel)
{
    public string FormatPercent(string format = "0") =>
        RemainingPercent is double percent ? $"{percent.ToString(format)}%" : "—";
}

public sealed record CliConfigResult(
    bool Success,
    string SettingsPath,
    string Message);

public sealed record ContextCategoryItem(
    string Key,
    string Label,
    long Tokens,
    double PercentageOfContext,
    double PercentageOfWindow,
    int ItemCount,
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
    double CompressionRatio,
    string Preview);

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
    int ThinkingChars,
    int ResponseChars,
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
    string TranscriptPath,
    long FileSizeBytes,
    DateTimeOffset StartedAt,
    DateTimeOffset LastActiveAt,
    bool IsActiveSession,
    bool IsRecentlyWriting,
    bool IsSubagent,
    string? ParentConversationId,
    string PrimaryModelId,
    string PrimaryModelDisplayName,
    IReadOnlyList<string> ModelsUsed,
    IReadOnlyList<QuotaGroupId> QuotaGroupsUsed,
    long ContextWindowSize,
    string ContextWindowSource,
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
    int ErrorCount,
    int MediaCount,
    int CompactionCount,
    double EstimatedCostUsd,
    double? LiveCostUsd,
    IReadOnlyList<ContextCategoryItem> Categories,
    long FreeSpaceTokens,
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
    string? PlanTier,
    string? AccountEmail,
    string? CliVersion,
    bool StatusLineConnected,
    DateTimeOffset? StatusLineLastSeenAt,
    IReadOnlyList<QuotaBucketStatus> QuotaBuckets,
    IReadOnlyList<QuotaHistoryPoint> QuotaHistory,
    IReadOnlyList<AvailableAccountModel> AvailableModels,
    IReadOnlyDictionary<WindowKey, WindowAnalytics> Windows,
    double? SprintVsWeeklyPaceRatio,
    IReadOnlyList<SessionDetail> Sessions,
    SessionDetail? ActiveSession,
    IReadOnlyList<UsageInsight> Insights,
    IReadOnlyList<string> ScannedRoots)
{
    public DateTimeOffset? DesktopQuotaLastSeenAt { get; init; }
}
