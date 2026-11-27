namespace UsageOrb.Core;

public static class AnalyticsEngine
{
    private static readonly (WindowKey Key, string Label, double? Hours)[] WindowDefs =
    [
        (WindowKey.FiveHours, "Last 5 Hours (Sprint Window)", 5.0),
        (WindowKey.TwentyFourHours, "Last 24 Hours", 24.0),
        (WindowKey.SevenDays, "Last 7 Days (Weekly Window)", 24.0 * 7),
        (WindowKey.ThirtyDays, "Last 30 Days", 24.0 * 30),
        (WindowKey.All, "All Recorded Sessions", null),
    ];

    internal static DashboardSnapshot Collect(
        AppSettings settings,
        DateTimeOffset? now = null,
        DesktopQuotaSnapshot? desktopQuota = null)
    {
        var current = now ?? DateTimeOffset.UtcNow;
        var (roots, discovered) = AntigravityPaths.DiscoverTranscripts();
        var summaries = ConversationSummaries.Read();
        var byId = discovered.ToDictionary(t => t.ConversationId, StringComparer.OrdinalIgnoreCase);

        foreach (var (id, summary) in summaries)
        {
            byId.TryAdd(id, new(id, summary.Surface, string.Empty, summary.LastModified.UtcTicks, 0));
        }

        var parsedList = byId.Values.OrderByDescending(t => t.LastWriteUtcTicks).Select(TranscriptParser.Parse).ToList();
        var parsedById = parsedList.ToDictionary(p => p.ConversationId, StringComparer.OrdinalIgnoreCase);
        var parentByChildId = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        foreach (var rec in parsedList)
        {
            foreach (var sub in rec.SpawnedSubagents)
            {
                parentByChildId[sub.ConversationId] = rec.ConversationId;
            }
        }
        foreach (var (id, summary) in summaries)
        {
            if (summary.ParentId is not null) parentByChildId[id] = summary.ParentId;
        }

        var latestPrimary = parsedList.FirstOrDefault(p => !parentByChildId.ContainsKey(p.ConversationId))
                            ?? parsedList.FirstOrDefault();
        var activeConvId = latestPrimary?.ConversationId;

        var sessions = new List<SessionDetail>(parsedList.Count);
        foreach (var rec in parsedList)
        {
            parentByChildId.TryGetValue(rec.ConversationId, out var parentId);
            summaries.TryGetValue(rec.ConversationId, out var summary);
            sessions.Add(TranscriptParser.BuildSessionDetail(
                rec,
                parentId,
                parsedById,
                current,
                summary));
        }

        sessions = sessions.OrderByDescending(s => s.LastActiveAt).ToList();
        var activeSession = activeConvId is not null
            ? sessions.FirstOrDefault(s => string.Equals(s.ConversationId, activeConvId, StringComparison.OrdinalIgnoreCase))
            : sessions.FirstOrDefault(s => !s.IsSubagent) ?? sessions.FirstOrDefault();

        var windows = new Dictionary<WindowKey, WindowAnalytics>();
        foreach (var def in WindowDefs)
        {
            windows[def.Key] = BuildWindowAnalytics(def.Key, def.Label, def.Hours, parsedList, current);
        }

        var quotaBuckets = desktopQuota?.BuildBucketStatuses(current) ?? [];

        var w5Rate = windows[WindowKey.FiveHours].BurnRateTokensPerHour;
        var w7Rate = windows[WindowKey.SevenDays].BurnRateTokensPerHour;
        double? paceRatio = w7Rate > 0 ? w5Rate / w7Rate : null;

        var insights = GenerateInsights(
            activeSession,
            quotaBuckets,
            quotaBuckets.Count > 0,
            windows[WindowKey.FiveHours],
            windows[WindowKey.SevenDays],
            settings,
            current);

        return new DashboardSnapshot(
            current,
            activeConvId,
            quotaBuckets,
            desktopQuota?.History.TakeLast(120).ToList() ?? [],
            windows,
            paceRatio,
            sessions,
            activeSession,
            insights,
            roots)
        {
            DesktopQuotaLastSeenAt = desktopQuota?.CapturedAt,
        };
    }

    internal static DashboardSnapshot ForDisplaySession(DashboardSnapshot snapshot, SessionDetail? session, AppSettings settings) =>
        snapshot with
        {
            ActiveSession = session,
            ActiveConversationId = session?.ConversationId,
            Insights = GenerateInsights(session, snapshot.QuotaBuckets, snapshot.QuotaBuckets.Count > 0,
                snapshot.Windows[WindowKey.FiveHours], snapshot.Windows[WindowKey.SevenDays], settings, DateTimeOffset.UtcNow),
        };

    private static WindowAnalytics BuildWindowAnalytics(
        WindowKey key,
        string label,
        double? hours,
        List<ParsedTranscriptRecord> records,
        DateTimeOffset now)
    {
        DateTimeOffset? start = hours.HasValue ? now.AddHours(-hours.Value) : null;

        int invocations = 0;
        int userTurns = 0;
        int compactions = 0;
        int errors = 0;
        long inputTokens = 0;
        long cacheReadTokens = 0;
        long outputTokens = 0;
        double estimatedCostUsd = 0;
        double cacheSavedUsd = 0;

        var activeSessionIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var groupAcc = new Dictionary<QuotaGroupId, GroupMutable>();
        var modelAcc = new Dictionary<string, ModelMutable>(StringComparer.OrdinalIgnoreCase);
        var toolAcc = new Dictionary<string, ToolMutable>(StringComparer.OrdinalIgnoreCase);

        bool hourlyMode = key is WindowKey.FiveHours or WindowKey.TwentyFourHours;
        var localNow = now.ToLocalTime();
        var buckets = new Dictionary<string, BucketMutable>();
        var bucketOrder = new List<string>();

        if (hourlyMode)
        {
            int count = key == WindowKey.FiveHours ? 6 : 24;
            var baseHour = new DateTimeOffset(localNow.Year, localNow.Month, localNow.Day, localNow.Hour, 0, 0, localNow.Offset);
            for (int i = count - 1; i >= 0; i--)
            {
                var dt = baseHour.AddHours(-i);
                var bKey = $"{dt.Year}-{dt.Month}-{dt.Day}-{dt.Hour}";
                buckets[bKey] = new BucketMutable($"{dt.Hour:00}:00", dt);
                bucketOrder.Add(bKey);
            }
        }
        else
        {
            int count = key == WindowKey.SevenDays ? 7 : (key == WindowKey.ThirtyDays ? 30 : 14);
            var baseDay = new DateTimeOffset(localNow.Year, localNow.Month, localNow.Day, 0, 0, 0, localNow.Offset);
            for (int i = count - 1; i >= 0; i--)
            {
                var dt = baseDay.AddDays(-i);
                var bKey = $"{dt.Year}-{dt.Month}-{dt.Day}";
                buckets[bKey] = new BucketMutable($"{dt.Month:00}-{dt.Day:00}", dt);
                bucketOrder.Add(bKey);
            }
        }

        var earliestStep = now;

        foreach (var rec in records)
        {
            bool sessionHadSteps = false;
            var sessionGroups = new HashSet<QuotaGroupId>();

            foreach (var step in rec.Steps)
            {
                if (start.HasValue && step.CreatedAt < start.Value) continue;

                sessionHadSteps = true;
                if (step.CreatedAt < earliestStep) earliestStep = step.CreatedAt;

                if (step.Type == "CHECKPOINT")
                {
                    compactions++;
                    continue;
                }

                invocations++;
                if (step.HasError) errors++;
                inputTokens += step.InputTokens;
                cacheReadTokens += step.CacheReadTokens;
                outputTokens += step.OutputTokens;
                estimatedCostUsd += step.EstimatedCostUsd;
                cacheSavedUsd += ModelCatalog.EstimateCacheSavingsUsd(step.ModelId, step.CacheReadTokens);

                var spec = ModelCatalog.Resolve(step.ModelId);
                sessionGroups.Add(spec.QuotaGroup);

                if (!groupAcc.TryGetValue(spec.QuotaGroup, out var g))
                {
                    g = new GroupMutable();
                    groupAcc[spec.QuotaGroup] = g;
                }

                g.Models.Add(spec.DisplayName);
                g.Sessions.Add(rec.ConversationId);
                g.Invocations++;
                g.InputTokens += step.InputTokens;
                g.CacheReadTokens += step.CacheReadTokens;
                g.OutputTokens += step.OutputTokens;
                g.EstimatedCostUsd += step.EstimatedCostUsd;

                if (!modelAcc.TryGetValue(step.ModelId, out var m))
                {
                    m = new ModelMutable();
                    modelAcc[step.ModelId] = m;
                }

                m.Sessions.Add(rec.ConversationId);
                m.Invocations++;
                m.InputTokens += step.InputTokens;
                m.CacheReadTokens += step.CacheReadTokens;
                m.OutputTokens += step.OutputTokens;
                m.ContextSum += step.TotalContextTokens;
                if (step.TotalContextTokens > m.PeakContext) m.PeakContext = step.TotalContextTokens;
                m.EstimatedCostUsd += step.EstimatedCostUsd;

                var stepLocal = step.CreatedAt.ToLocalTime();
                var bKey = hourlyMode
                    ? $"{stepLocal.Year}-{stepLocal.Month}-{stepLocal.Day}-{stepLocal.Hour}"
                    : $"{stepLocal.Year}-{stepLocal.Month}-{stepLocal.Day}";
                if (buckets.TryGetValue(bKey, out var b))
                {
                    b.InputTokens += step.InputTokens;
                    b.CacheReadTokens += step.CacheReadTokens;
                    b.OutputTokens += step.OutputTokens;
                    b.Invocations++;
                    b.EstimatedCostUsd += step.EstimatedCostUsd;
                }
            }

            if (sessionHadSteps)
            {
                activeSessionIds.Add(rec.ConversationId);
                userTurns += rec.UserTurns;
                foreach (var gid in sessionGroups)
                {
                    if (groupAcc.TryGetValue(gid, out var g)) g.UserTurns += rec.UserTurns;
                }

                foreach (var t in rec.Tools)
                {
                    if (!toolAcc.TryGetValue(t.Name, out var agg))
                    {
                        agg = new ToolMutable();
                        toolAcc[t.Name] = agg;
                    }

                    agg.CallCount += t.CallCount;
                    agg.ErrorCount += t.ErrorCount;
                    agg.ArgTokens += t.EstimatedArgTokens;
                    agg.OutputTokens += t.EstimatedOutputTokens;
                    if (t.MaxSingleOutputTokens > agg.MaxSingleOutput) agg.MaxSingleOutput = t.MaxSingleOutputTokens;
                }
            }
        }

        long totalTokens = inputTokens + cacheReadTokens + outputTokens;
        long totalInCache = inputTokens + cacheReadTokens;
        double cacheHitRate = totalInCache > 0 ? (double)cacheReadTokens / totalInCache : 0;
        double hoursSpan = hours ?? Math.Max(1.0, (now - earliestStep).TotalHours);

        var byQuotaGroup = groupAcc
            .Select(kv =>
            {
                var g = kv.Value;
                long gTot = g.InputTokens + g.CacheReadTokens + g.OutputTokens;
                long gInCache = g.InputTokens + g.CacheReadTokens;
                return new QuotaGroupUsage(
                    kv.Key,
                    ModelCatalog.GetQuotaGroupLabel(kv.Key),
                    g.Models.OrderBy(x => x).ToList(),
                    g.Invocations,
                    g.UserTurns,
                    g.Sessions.Count,
                    g.InputTokens,
                    g.CacheReadTokens,
                    g.OutputTokens,
                    gTot,
                    gInCache > 0 ? (double)g.CacheReadTokens / gInCache : 0,
                    g.EstimatedCostUsd,
                    totalTokens > 0 ? (double)gTot / totalTokens : 0,
                    gTot / hoursSpan,
                    g.Invocations / hoursSpan);
            })
            .OrderByDescending(g => g.TotalTokens)
            .ToList();

        var byModel = modelAcc
            .Select(kv =>
            {
                var spec = ModelCatalog.Resolve(kv.Key);
                var m = kv.Value;
                long mTot = m.InputTokens + m.CacheReadTokens + m.OutputTokens;
                long mInCache = m.InputTokens + m.CacheReadTokens;
                return new ModelUsageAggregate(
                    kv.Key,
                    spec.DisplayName,
                    spec.QuotaGroup,
                    spec.QuotaGroupLabel,
                    spec.ContextWindow,
                    m.Invocations,
                    m.Sessions.Count,
                    m.InputTokens,
                    m.CacheReadTokens,
                    m.OutputTokens,
                    mTot,
                    mInCache > 0 ? (double)m.CacheReadTokens / mInCache : 0,
                    m.Invocations > 0 ? m.ContextSum / m.Invocations : 0,
                    m.PeakContext,
                    m.Invocations > 0 ? m.OutputTokens / m.Invocations : 0,
                    m.EstimatedCostUsd,
                    totalTokens > 0 ? (double)mTot / totalTokens : 0);
            })
            .OrderByDescending(m => m.TotalTokens)
            .ToList();

        long totalToolTokens = toolAcc.Values.Sum(t => t.ArgTokens + t.OutputTokens);
        var topTools = toolAcc
            .Select(kv =>
            {
                long tot = kv.Value.ArgTokens + kv.Value.OutputTokens;
                return new ToolContextStat(
                    kv.Key,
                    kv.Value.CallCount,
                    kv.Value.ErrorCount,
                    kv.Value.ArgTokens,
                    kv.Value.OutputTokens,
                    tot,
                    totalToolTokens > 0 ? (double)tot / totalToolTokens : 0,
                    kv.Value.MaxSingleOutput);
            })
            .OrderByDescending(t => t.EstimatedTotalTokens)
            .Take(15)
            .ToList();

        var timeline = bucketOrder
            .Select(k =>
            {
                var b = buckets[k];
                return new TimeBucketPoint(b.Label, b.Start, b.InputTokens, b.CacheReadTokens, b.OutputTokens, b.Invocations, b.EstimatedCostUsd);
            })
            .ToList();

        return new WindowAnalytics(
            key,
            label,
            start,
            now,
            hoursSpan,
            activeSessionIds.Count,
            invocations,
            userTurns,
            compactions,
            errors,
            inputTokens,
            cacheReadTokens,
            outputTokens,
            totalTokens,
            cacheHitRate,
            estimatedCostUsd,
            cacheSavedUsd,
            totalTokens / hoursSpan,
            invocations / hoursSpan,
            byQuotaGroup,
            byModel,
            topTools,
            timeline);
    }

    private static List<UsageInsight> GenerateInsights(
        SessionDetail? active,
        IReadOnlyList<QuotaBucketStatus> quotaBuckets,
        bool quotaAvailable,
        WindowAnalytics w5h,
        WindowAnalytics w7d,
        AppSettings settings,
        DateTimeOffset now)
    {
        var list = new List<UsageInsight>();

        foreach (var b in quotaBuckets)
        {
            if (!b.Disabled && !b.IsStale(now) && b.GetLiveResetInSeconds(now) is not 0 && b.RemainingFraction.HasValue)
            {
                double remPct = b.RemainingFraction.Value * 100.0;
                if (remPct <= settings.QuotaLowPercent)
                {
                    list.Add(new UsageInsight(
                        remPct <= 10 ? "critical" : "warning",
                        "QUOTA_LOW",
                        $"Low quota on {b.Label} ({remPct:F1}% left)",
                        b.WillExhaustBeforeReset == true && b.ProjectedExhaustionTime.HasValue
                            ? $"At current pace, projected to reach 0% around {b.ProjectedExhaustionTime.Value.ToLocalTime():HH:mm} before the window resets."
                            : "Consider routing routine steps to Gemini Flash or Orchestrator until the window resets.",
                        "Use Orchestrator or Gemini 3.8 Flash for routine edits."));
                }
            }
        }

        if (active is not null)
        {
            if (active.ContextUsedPercent >= settings.ContextCriticalPercent)
            {
                list.Add(new UsageInsight(
                    "critical",
                    "CONTEXT_CRITICAL",
                    $"Context nearly full ({active.ContextUsedPercent:F1}%)",
                    $"{FormatUtil.Exact(active.CurrentContextTokens)} / {FormatUtil.Exact(active.ContextWindowSize)} tokens active on {active.PrimaryModelDisplayName}. Auto-compaction is imminent.",
                    "Run /compact now to summarize progress cleanly before automatic truncation."));
            }
            else if (active.ContextUsedPercent >= settings.ContextWarnPercent)
            {
                list.Add(new UsageInsight(
                    "warning",
                    "CONTEXT_HIGH",
                    $"Context elevated ({active.ContextUsedPercent:F1}%)",
                    $"{FormatUtil.Exact(active.CurrentContextTokens)} / {FormatUtil.Exact(active.ContextWindowSize)} tokens active.",
                    "Consider /compact after the current milestone or /btw for side questions."));
            }

            if (active.Exceeds200kTokens)
            {
                list.Add(new UsageInsight(
                    "info",
                    "EXCEEDS_200K",
                    "Active context exceeds 200K tokens",
                    $"Current context is {FormatUtil.Exact(active.CurrentContextTokens)} tokens (>200K). Larger prompts increase latency and quota burn per turn.",
                    "Use /compact or start a new conversation for unrelated tasks."));
            }

            if (active.ModelInvocations >= 4 && active.OverallCacheHitRate < 0.45)
            {
                list.Add(new UsageInsight(
                    "warning",
                    "LOW_CACHE_HIT",
                    $"Low prompt cache hit rate ({active.OverallCacheHitRate * 100:F1}%)",
                    "Over 55% of prompt tokens are uncached in this session, increasing quota consumption.",
                    "Avoid frequent model switches or large prefix mutations mid-conversation."));
            }

            if (active.Tools.Count > 0 && active.Tools[0].EstimatedTotalTokens > 25_000 && active.Tools[0].ShareOfToolTokens > 0.45)
            {
                var top = active.Tools[0];
                list.Add(new UsageInsight(
                    "info",
                    "TOP_TOOL_BLOAT",
                    $"Top context consumer: {top.Name}",
                    $"{top.Name} ({top.CallCount} calls) generated ~{FormatUtil.Tokens(top.EstimatedTotalTokens)} tokens ({top.ShareOfToolTokens * 100:0}% of tool context).",
                    "Use targeted line ranges or concise command filters."));
            }
        }

        if (settings.FiveHourTokenBudget.HasValue && w5h.TotalTokens >= settings.FiveHourTokenBudget.Value)
        {
            list.Add(new UsageInsight(
                "warning",
                "BUDGET_5H",
                "Custom 5-hour token budget reached",
                $"Used {FormatUtil.Tokens(w5h.TotalTokens)} vs configured {FormatUtil.Tokens(settings.FiveHourTokenBudget.Value)} budget.",
                null));
        }

        if (settings.WeeklyTokenBudget.HasValue && w7d.TotalTokens >= settings.WeeklyTokenBudget.Value)
        {
            list.Add(new UsageInsight(
                "warning",
                "BUDGET_7D",
                "Custom 7-day token budget reached",
                $"Used {FormatUtil.Tokens(w7d.TotalTokens)} vs configured {FormatUtil.Tokens(settings.WeeklyTokenBudget.Value)} budget.",
                null));
        }

        if (!quotaAvailable)
        {
            list.Add(new UsageInsight(
                "info",
                "QUOTA_UNAVAILABLE",
                "Waiting for account quota",
                "UsageOrb automatically reads model quotas from the running Antigravity App. The App must be signed in and able to load its Models settings.",
                null));
        }

        return list;
    }

    private sealed class GroupMutable
    {
        public readonly HashSet<string> Models = new(StringComparer.OrdinalIgnoreCase);
        public readonly HashSet<string> Sessions = new(StringComparer.OrdinalIgnoreCase);
        public int Invocations;
        public int UserTurns;
        public long InputTokens;
        public long CacheReadTokens;
        public long OutputTokens;
        public double EstimatedCostUsd;
    }

    private sealed class ModelMutable
    {
        public readonly HashSet<string> Sessions = new(StringComparer.OrdinalIgnoreCase);
        public int Invocations;
        public long InputTokens;
        public long CacheReadTokens;
        public long OutputTokens;
        public long ContextSum;
        public long PeakContext;
        public double EstimatedCostUsd;
    }

    private sealed class ToolMutable
    {
        public int CallCount;
        public int ErrorCount;
        public long ArgTokens;
        public long OutputTokens;
        public long MaxSingleOutput;
    }

    private sealed class BucketMutable(string label, DateTimeOffset start)
    {
        public string Label { get; } = label;
        public DateTimeOffset Start { get; } = start;
        public long InputTokens;
        public long CacheReadTokens;
        public long OutputTokens;
        public int Invocations;
        public double EstimatedCostUsd;
    }
}
