using System.Collections.Concurrent;
using System.IO;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace UsageOrb.Core;

public sealed class ParsedTranscriptRecord
{
    public required string ConversationId { get; init; }
    public required AntigravitySurface Surface { get; init; }
    public required long FileSizeBytes { get; init; }
    public required long LastWriteUtcTicks { get; init; }
    public required string Title { get; init; }
    public string? InferredWorkspace { get; init; }
    public required DateTimeOffset LastActiveAt { get; init; }
    public required string PrimaryModelId { get; init; }
    public required int UserTurns { get; init; }
    public required int ModelInvocations { get; init; }
    public required int ToolCallCount { get; init; }
    public required long TotalInputTokens { get; init; }
    public required long TotalCacheReadTokens { get; init; }
    public required long TotalOutputTokens { get; init; }
    public required double EstimatedCostUsd { get; init; }
    public required long PeakContextTokens { get; init; }
    public required long LatestInputTokens { get; init; }
    public required long LatestCacheReadTokens { get; init; }
    public required long LatestOutputTokens { get; init; }
    public required long CurrentContextTokens { get; init; }
    public required long LastContextDelta { get; init; }
    public required IReadOnlyList<StepTelemetry> Steps { get; init; }
    public required IReadOnlyList<CompactionEvent> Compactions { get; init; }
    public required IReadOnlyList<ToolContextStat> Tools { get; init; }
    public required Dictionary<string, long> RawActiveCategories { get; init; }
    public required long BaselineSystemOverheadTokens { get; init; }
    public required long LatestCheckpointSummaryTokens { get; init; }
    public required IReadOnlyList<HeaviestStepInfo> HeaviestSteps { get; init; }
    public required IReadOnlyList<SpawnedSubagentRef> SpawnedSubagents { get; init; }
}

public sealed record SpawnedSubagentRef(
    string ConversationId,
    string Role,
    string TypeName,
    string RequestedModel,
    int StepIndex);

public static partial class TranscriptParser
{
    private sealed record CacheEntry(long LastWriteUtcTicks, long SizeBytes, ParsedTranscriptRecord Parsed);

    private static readonly ConcurrentDictionary<string, CacheEntry> Cache = new(StringComparer.OrdinalIgnoreCase);

    private static readonly (string Key, string Label, string ColorHex)[] CategoryMeta =
    [
        ("system_overhead", "System Prompt & Tools", "#6366F1"),
        ("checkpoint_summary", "Checkpoint Buffer", "#A855F7"),
        ("user_messages", "User Messages", "#3B82F6"),
        ("agent_thinking", "Agent Thinking", "#F59E0B"),
        ("agent_responses", "Agent Responses", "#10B981"),
        ("tool_arguments", "Tool Arguments", "#06B6D4"),
        ("tool_outputs", "Tool Outputs & Files", "#EF4444"),
        ("system_messages", "System Notices", "#64748B"),
        ("media", "Media & Images", "#EC4899"),
    ];

    public static void ClearCache() => Cache.Clear();

    /// <summary>
    /// Estimates tokens from text, accounting for CJK characters (~1.5 chars/token),
    /// Latin/ASCII (~4 chars/token), and compact transcript truncation markers.
    /// </summary>
    public static long EstimateTextTokens(string? text)
    {
        if (string.IsNullOrEmpty(text)) return 0;

        long truncatedBytes = 0;
        foreach (Match match in TruncatedBytesRegex().Matches(text))
        {
            if (long.TryParse(match.Groups[1].Value, out var bytes))
            {
                truncatedBytes += bytes;
            }
        }

        int cjkCount = 0;
        for (int i = 0; i < text.Length; i++)
        {
            char ch = text[i];
            if ((ch >= '\u4E00' && ch <= '\u9FFF') ||
                (ch >= '\u3040' && ch <= '\u30FF') ||
                (ch >= '\uAC00' && ch <= '\uD7AF'))
            {
                cjkCount++;
            }
        }

        int nonCjk = text.Length - cjkCount;
        long visibleTokens = (long)Math.Ceiling(cjkCount / 1.5 + nonCjk / 4.0);
        long truncatedTokens = (long)Math.Ceiling(truncatedBytes / 3.6);
        return visibleTokens + truncatedTokens;
    }

    public static ParsedTranscriptRecord Parse(DiscoveredTranscript item)
    {
        if (item.SizeBytes == 0) return BuildParsedRecord(item, []);

        if (Cache.TryGetValue(item.TranscriptPath, out var cached) &&
            cached.LastWriteUtcTicks == item.LastWriteUtcTicks &&
            cached.SizeBytes == item.SizeBytes)
        {
            return cached.Parsed;
        }

        var lines = ReadAllLinesShared(item.TranscriptPath);
        var docs = new List<JsonDocument>(lines.Count);

        try
        {
            foreach (var raw in lines)
            {
                var trimmed = raw.Trim();
                if (trimmed.Length == 0) continue;
                try
                {
                    var doc = JsonDocument.Parse(trimmed);
                    if (doc.RootElement.ValueKind == JsonValueKind.Object) docs.Add(doc);
                    else doc.Dispose();
                }
                catch
                {
                    // Skip incomplete trailing line while Antigravity is actively writing
                }
            }

            var parsed = BuildParsedRecord(item, docs);
            if (docs.Count > 0) Cache[item.TranscriptPath] = new CacheEntry(item.LastWriteUtcTicks, item.SizeBytes, parsed);
            return parsed;
        }
        finally
        {
            foreach (var doc in docs)
            {
                doc.Dispose();
            }
        }
    }

    private static List<string> ReadAllLinesShared(string path)
    {
        var result = new List<string>();
        try
        {
            using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var reader = new StreamReader(fs);
            while (reader.ReadLine() is { } line)
            {
                result.Add(line);
            }
        }
        catch
        {
            // Return empty list if file was deleted mid-scan
        }

        return result;
    }

    private static ParsedTranscriptRecord BuildParsedRecord(DiscoveredTranscript item, List<JsonDocument> docs)
    {
        var defaultTime = new DateTimeOffset(item.LastWriteUtcTicks, TimeSpan.Zero);
        var lastActiveAt = defaultTime;

        string title = "Untitled Session";
        bool titleFound = false;

        var modelCounts = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        int userTurns = 0;
        int modelInvocations = 0;
        int toolCallCount = 0;
        long totalInputTokens = 0;
        long totalCacheReadTokens = 0;
        long totalOutputTokens = 0;
        double estimatedCostUsd = 0;
        long peakContextTokens = 0;
        long latestInputTokens = 0;
        long latestCacheReadTokens = 0;
        long latestOutputTokens = 0;
        long currentContextTokens = 0;
        long prevContextTokens = 0;
        long lastContextDelta = 0;
        string lastPlannerModel = "unknown";

        var steps = new List<StepTelemetry>();
        var compactions = new List<CompactionEvent>();
        var toolStats = new Dictionary<string, ToolMutableStat>(StringComparer.OrdinalIgnoreCase);
        var pendingToolNames = new Queue<string>();
        var pendingSubagents = new Queue<(string Role, string TypeName, string RequestedModel, int StepIndex)>();
        var spawnedSubagents = new List<SpawnedSubagentRef>();
        var observedProjectPaths = new List<string>();

        // Find latest CHECKPOINT index so category composition reflects the active context window
        int lastCheckpointIdx = -1;
        for (int i = 0; i < docs.Count; i++)
        {
            var step = docs[i].RootElement;
            if (GetString(step, "type") == "CHECKPOINT" && IsCompleted(step))
            {
                lastCheckpointIdx = i;
            }
        }

        int activeStartIdx = lastCheckpointIdx >= 0 ? lastCheckpointIdx : 0;

        var rawActiveCategories = new Dictionary<string, long>(StringComparer.Ordinal);

        long baselineSystemOverhead = 0;
        bool capturedBaseline = false;
        long latestCheckpointSummary = 0;
        long preFirstPlannerUserTokens = 0;
        var heaviestCandidates = new List<HeaviestStepInfo>();

        for (int i = 0; i < docs.Count; i++)
        {
            var root = docs[i].RootElement;
            bool inActiveWindow = i >= activeStartIdx;
            int stepIdx = GetInt(root, "step_index") ?? i;
            string type = GetString(root, "type") ?? "";
            string status = GetString(root, "status") ?? "";

            var createdAt = lastActiveAt;
            var createdRaw = GetString(root, "created_at");
            if (!string.IsNullOrEmpty(createdRaw) && DateTimeOffset.TryParse(createdRaw, out var parsedTs))
            {
                createdAt = parsedTs;
                lastActiveAt = parsedTs;
            }

            bool hasError = (root.TryGetProperty("error", out var errProp) && errProp.ValueKind != JsonValueKind.Null &&
                             (errProp.ValueKind != JsonValueKind.String || !string.IsNullOrEmpty(errProp.GetString()))) ||
                            string.Equals(status, "ERROR", StringComparison.OrdinalIgnoreCase);

            if (inActiveWindow && root.TryGetProperty("media", out var mediaProp) && mediaProp.ValueKind == JsonValueKind.Array)
            {
                int mediaCount = mediaProp.GetArrayLength();
                if (mediaCount > 0) AddCategory(rawActiveCategories, "media", mediaCount * 258L);
            }

            if (type == "USER_INPUT")
            {
                userTurns++;
                var content = GetString(root, "content");
                if (!titleFound)
                {
                    title = ExtractTitle(content);
                    titleFound = true;
                }

                long userTok = EstimateTextTokens(content);
                if (!capturedBaseline && inActiveWindow)
                {
                    preFirstPlannerUserTokens += userTok;
                }

                if (inActiveWindow)
                {
                    AddCategory(rawActiveCategories, "user_messages", userTok);
                    if (userTok > 150)
                    {
                        heaviestCandidates.Add(new HeaviestStepInfo(stepIdx, "USER_INPUT", $"User prompt (#{userTurns})", userTok, createdAt));
                    }
                }

                continue;
            }

            if (type == "SYSTEM_MESSAGE")
            {
                long sysTok = EstimateTextTokens(GetString(root, "content"));
                if (inActiveWindow)
                {
                    AddCategory(rawActiveCategories, "system_messages", sysTok);
                    if (sysTok > 300)
                    {
                        heaviestCandidates.Add(new HeaviestStepInfo(stepIdx, "SYSTEM_MESSAGE", "System notice / task output", sysTok, createdAt));
                    }
                }

                continue;
            }

            if (type == "CHECKPOINT" && IsCompleted(root))
            {
                var content = GetString(root, "content") ?? "";
                long? inputTok = GetLong(root, "input_tokens");
                long? cacheTok = GetLong(root, "cache_read_tokens");
                long beforeTok = inputTok.HasValue || cacheTok.HasValue
                    ? Math.Max(0L, inputTok ?? 0) + Math.Max(0L, cacheTok ?? 0)
                    : prevContextTokens;
                long summaryTok = Math.Max(0L, GetLong(root, "output_tokens") ?? EstimateTextTokens(content));
                long freedTok = Math.Max(0L, beforeTok - summaryTok);
                double ratio = beforeTok > 0 ? (double)freedTok / beforeTok : 0;

                compactions.Add(new CompactionEvent(stepIdx, createdAt, beforeTok, summaryTok, freedTok, ratio));

                var spec = ModelCatalog.Resolve(lastPlannerModel);
                long delta = summaryTok - prevContextTokens;
                steps.Add(new StepTelemetry(
                    stepIdx,
                    createdAt,
                    "CHECKPOINT",
                    lastPlannerModel,
                    spec.DisplayName,
                    Math.Max(0L, inputTok ?? beforeTok - (cacheTok ?? 0)),
                    cacheTok ?? 0,
                    summaryTok,
                    delta,
                    summaryTok,
                    0,
                    [],
                    0,
                    hasError,
                    ModelCatalog.EstimateCostUsd(lastPlannerModel, beforeTok, 0, summaryTok)));

                prevContextTokens = summaryTok;
                currentContextTokens = summaryTok;
                latestOutputTokens = 0;
                lastContextDelta = delta;

                if (i == lastCheckpointIdx)
                {
                    latestCheckpointSummary = summaryTok;
                    rawActiveCategories["checkpoint_summary"] = summaryTok;
                    capturedBaseline = false;
                    preFirstPlannerUserTokens = 0;
                }

                continue;
            }

            if (type == "PLANNER_RESPONSE" && IsCompleted(root))
            {
                modelInvocations++;
                var modelId = GetString(root, "model");
                if (string.IsNullOrWhiteSpace(modelId)) modelId = lastPlannerModel;
                lastPlannerModel = modelId;

                var spec = ModelCatalog.Resolve(modelId);
                modelCounts[modelId] = modelCounts.GetValueOrDefault(modelId) + 1;

                long inputTok = Math.Max(0L, GetLong(root, "input_tokens") ?? 0);
                long cacheTok = Math.Max(0L, GetLong(root, "cache_read_tokens") ?? 0);
                long outTok = Math.Max(0L, GetLong(root, "output_tokens") ?? 0);
                long totalCtx = inputTok + cacheTok;

                totalInputTokens += inputTok;
                totalCacheReadTokens += cacheTok;
                totalOutputTokens += outTok;
                double stepCost = ModelCatalog.EstimateCostUsd(modelId, inputTok, cacheTok, outTok);
                estimatedCostUsd += stepCost;

                if (totalCtx > peakContextTokens) peakContextTokens = totalCtx;
                long delta = 0;
                if (totalCtx > 0)
                {
                    latestInputTokens = inputTok;
                    latestCacheReadTokens = cacheTok;
                    latestOutputTokens = outTok;
                    currentContextTokens = totalCtx;
                    delta = totalCtx - prevContextTokens;
                    prevContextTokens = totalCtx;
                    lastContextDelta = delta;
                }

                if (inActiveWindow && !capturedBaseline && totalCtx > 0)
                {
                    long subtracted = preFirstPlannerUserTokens + latestCheckpointSummary;
                    baselineSystemOverhead = Math.Max(0L, totalCtx - subtracted);
                    rawActiveCategories["system_overhead"] = baselineSystemOverhead;
                    capturedBaseline = true;
                }

                var stepToolNames = new List<string>();
                pendingToolNames.Clear();

                if (root.TryGetProperty("tool_calls", out var tcProp) && tcProp.ValueKind == JsonValueKind.Array)
                {
                    foreach (var tc in tcProp.EnumerateArray())
                    {
                        var tName = GetString(tc, "name") ?? "unknown_tool";
                        stepToolNames.Add(tName);
                        pendingToolNames.Enqueue(tName);
                        toolCallCount++;

                        var stat = GetOrCreateToolStat(toolStats, tName);
                        stat.CallCount++;
                        string argsRaw = tc.TryGetProperty("args", out var argsEl) ? argsEl.GetRawText() : "";
                        long argTok = EstimateTextTokens(argsRaw);
                        stat.ArgTokens += argTok;
                        if (inActiveWindow)
                        {
                            AddCategory(rawActiveCategories, "tool_arguments", argTok);
                        }

                        if (tc.TryGetProperty("args", out var subArgs) && subArgs.ValueKind == JsonValueKind.Object)
                        {
                            if (observedProjectPaths.Count < 40)
                            {
                                var candidatePath = Unquote(
                                    GetString(subArgs, "Path") ??
                                    GetString(subArgs, "path") ??
                                    GetString(subArgs, "Cwd") ??
                                    GetString(subArgs, "cwd") ??
                                    "");
                                if (!string.IsNullOrWhiteSpace(candidatePath) &&
                                    !candidatePath.Contains(".gemini", StringComparison.OrdinalIgnoreCase) &&
                                    Path.IsPathRooted(candidatePath))
                                {
                                    observedProjectPaths.Add(candidatePath);
                                }
                            }

                            if (tName == "invoke_subagent")
                            {
                                var role = Unquote(GetString(subArgs, "Role") ?? GetString(subArgs, "role") ?? "Subagent");
                                var typeName = Unquote(GetString(subArgs, "TypeName") ?? GetString(subArgs, "typeName") ?? "subagent");
                                var reqModel = Unquote(GetString(subArgs, "Model") ?? GetString(subArgs, "model") ?? "inherit");
                                pendingSubagents.Enqueue((role, typeName, reqModel, stepIdx));
                            }
                        }
                    }
                }

                var thinking = GetString(root, "thinking");
                var content = GetString(root, "content");
                long thinkingTok = EstimateTextTokens(thinking);
                long contentTok = EstimateTextTokens(content);

                if (inActiveWindow)
                {
                    if (thinkingTok > 0) AddCategory(rawActiveCategories, "agent_thinking", thinkingTok);
                    if (contentTok > 0) AddCategory(rawActiveCategories, "agent_responses", contentTok);
                }

                steps.Add(new StepTelemetry(
                    stepIdx,
                    createdAt,
                    "PLANNER_RESPONSE",
                    modelId,
                    spec.DisplayName,
                    inputTok,
                    cacheTok,
                    totalCtx,
                    delta,
                    outTok,
                    totalCtx > 0 ? (double)cacheTok / totalCtx : 0,
                    stepToolNames,
                    stepToolNames.Count,
                    hasError,
                    stepCost));

                continue;
            }

            if (type == "GENERIC")
            {
                var associatedTool = pendingToolNames.Count > 0 ? pendingToolNames.Dequeue() : "tool_output";
                var content = GetString(root, "content");
                long outTok = EstimateTextTokens(content);
                var stat = GetOrCreateToolStat(toolStats, associatedTool);
                stat.OutputTokens += outTok;
                if (outTok > stat.MaxSingleOutput) stat.MaxSingleOutput = outTok;
                if (hasError) stat.ErrorCount++;

                if (associatedTool == "invoke_subagent" && !string.IsNullOrEmpty(content))
                {
                    var match = SubagentIdRegex().Match(content);
                    var callInfo = pendingSubagents.Count > 0
                        ? pendingSubagents.Dequeue()
                        : ("Subagent", "subagent", "inherit", stepIdx);
                    if (match.Success)
                    {
                        spawnedSubagents.Add(new SpawnedSubagentRef(
                            match.Groups[1].Value,
                            callInfo.Item1,
                            callInfo.Item2,
                            callInfo.Item3,
                            callInfo.Item4));
                    }
                }

                if (inActiveWindow)
                {
                    AddCategory(rawActiveCategories, "tool_outputs", outTok);
                    if (outTok > 250)
                    {
                        heaviestCandidates.Add(new HeaviestStepInfo(stepIdx, "TOOL_OUTPUT", $"{associatedTool} output", outTok, createdAt));
                    }
                }
            }
        }

        string primaryModel = lastPlannerModel;
        if ((string.IsNullOrWhiteSpace(primaryModel) || primaryModel == "unknown") && modelCounts.Count > 0)
        {
            primaryModel = modelCounts.OrderByDescending(kv => kv.Value).First().Key;
        }

        long totalToolTokens = toolStats.Values.Sum(s => s.ArgTokens + s.OutputTokens);
        var tools = toolStats
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
            .ToList();

        var heaviestSteps = heaviestCandidates
            .OrderByDescending(h => h.EstimatedTokens)
            .Take(12)
            .ToList();

        return new ParsedTranscriptRecord
        {
            ConversationId = item.ConversationId,
            Surface = item.Surface,
            FileSizeBytes = item.SizeBytes,
            LastWriteUtcTicks = item.LastWriteUtcTicks,
            Title = title,
            InferredWorkspace = InferWorkspacePath(observedProjectPaths),
            LastActiveAt = lastActiveAt,
            PrimaryModelId = primaryModel,
            UserTurns = userTurns,
            ModelInvocations = modelInvocations,
            ToolCallCount = toolCallCount,
            TotalInputTokens = totalInputTokens,
            TotalCacheReadTokens = totalCacheReadTokens,
            TotalOutputTokens = totalOutputTokens,
            EstimatedCostUsd = estimatedCostUsd,
            PeakContextTokens = peakContextTokens,
            LatestInputTokens = latestInputTokens,
            LatestCacheReadTokens = latestCacheReadTokens,
            LatestOutputTokens = latestOutputTokens,
            CurrentContextTokens = currentContextTokens,
            LastContextDelta = lastContextDelta,
            Steps = steps,
            Compactions = compactions,
            Tools = tools,
            RawActiveCategories = rawActiveCategories,
            BaselineSystemOverheadTokens = baselineSystemOverhead,
            LatestCheckpointSummaryTokens = latestCheckpointSummary,
            HeaviestSteps = heaviestSteps,
            SpawnedSubagents = spawnedSubagents,
        };
    }

    internal static SessionDetail BuildSessionDetail(
        ParsedTranscriptRecord record,
        string? parentConversationId,
        IReadOnlyDictionary<string, ParsedTranscriptRecord> allParsedById,
        DateTimeOffset now,
        ConversationSummary? summary)
    {
        var spec = ModelCatalog.Resolve(record.PrimaryModelId);
        long currentCtx = record.CurrentContextTokens;
        long windowSize = spec.ContextWindow;
        double usedPct = Math.Clamp((double)currentCtx / windowSize * 100.0, 0, 100);
        long remaining = Math.Max(0L, windowSize - currentCtx);

        // Normalize active-window categories to sum cleanly to currentCtx
        long anchoredSystem = Math.Min(currentCtx, record.BaselineSystemOverheadTokens);
        long anchoredCheckpoint = Math.Min(Math.Max(0L, currentCtx - anchoredSystem), record.LatestCheckpointSummaryTokens);
        long dynamicBudget = Math.Max(0L, currentCtx - anchoredSystem - anchoredCheckpoint);

        string[] dynamicKeys =
        [
            "user_messages",
            "agent_thinking",
            "agent_responses",
            "tool_arguments",
            "tool_outputs",
            "system_messages",
            "media",
        ];

        long rawDynamicSum = dynamicKeys.Sum(k => record.RawActiveCategories.GetValueOrDefault(k));

        var categories = new List<ContextCategoryItem>();
        foreach (var (key, label, colorHex) in CategoryMeta)
        {
            long weight = record.RawActiveCategories.GetValueOrDefault(key);
            long tokens = key switch
            {
                "system_overhead" => anchoredSystem,
                "checkpoint_summary" => anchoredCheckpoint,
                _ => rawDynamicSum > 0 ? (long)Math.Round((double)weight / rawDynamicSum * dynamicBudget) : 0L,
            };

            if (tokens > 0 || key is "user_messages" or "agent_responses" or "tool_outputs")
            {
                categories.Add(new ContextCategoryItem(
                    key,
                    label,
                    tokens,
                    currentCtx > 0 ? (double)tokens / currentCtx * 100.0 : 0,
                    windowSize > 0 ? (double)tokens / windowSize * 100.0 : 0,
                    colorHex));
            }
        }

        var subagents = record.SpawnedSubagents.Select(s =>
        {
            allParsedById.TryGetValue(s.ConversationId, out var child);
            return new SubagentLink(
                s.ConversationId,
                s.Role,
                s.TypeName,
                s.RequestedModel,
                s.StepIndex,
                child?.TotalInputTokens ?? 0,
                child?.TotalCacheReadTokens ?? 0,
                child?.TotalOutputTokens ?? 0,
                child?.PeakContextTokens ?? 0,
                child?.EstimatedCostUsd ?? 0,
                child?.ModelInvocations ?? 0,
                child is not null);
        }).ToList();

        var rolledUp = new RolledUpTotals(
            record.TotalInputTokens + subagents.Sum(s => s.TotalInputTokens),
            record.TotalCacheReadTokens + subagents.Sum(s => s.TotalCacheReadTokens),
            record.TotalOutputTokens + subagents.Sum(s => s.TotalOutputTokens),
            record.ModelInvocations + subagents.Sum(s => s.Invocations),
            record.EstimatedCostUsd + subagents.Sum(s => s.EstimatedCostUsd));

        long totalInAndCache = record.TotalInputTokens + record.TotalCacheReadTokens;
        long totalBilled = totalInAndCache + record.TotalOutputTokens;
        double cacheHitRate = totalInAndCache > 0 ? (double)record.TotalCacheReadTokens / totalInAndCache : 0;
        string? workspace = summary?.Workspace ?? record.InferredWorkspace;
        string title = !string.IsNullOrWhiteSpace(summary?.Title) ? summary.Title : record.Title;
        var mtimeUtc = new DateTimeOffset(record.LastWriteUtcTicks, TimeSpan.Zero);
        bool isRecentlyWriting = record.FileSizeBytes > 0 && mtimeUtc >= now.AddSeconds(-15);

        return new SessionDetail(
            record.ConversationId,
            record.Surface,
            title,
            workspace,
            record.LastActiveAt,
            isRecentlyWriting,
            parentConversationId is not null,
            spec.Id,
            spec.DisplayName,
            windowSize,
            currentCtx,
            currentCtx + record.LatestOutputTokens,
            usedPct,
            remaining,
            currentCtx > 200_000,
            Math.Max(record.PeakContextTokens, currentCtx),
            record.LatestInputTokens,
            record.LatestCacheReadTokens,
            record.LatestOutputTokens,
            record.LastContextDelta,
            record.TotalInputTokens,
            record.TotalCacheReadTokens,
            record.TotalOutputTokens,
            totalBilled,
            cacheHitRate,
            record.UserTurns,
            record.ModelInvocations,
            record.ToolCallCount,
            record.Compactions.Count,
            record.EstimatedCostUsd,
            categories,
            record.LatestCheckpointSummaryTokens,
            record.Compactions,
            record.Steps,
            record.Tools,
            record.HeaviestSteps,
            subagents,
            rolledUp);
    }

    private static bool IsCompleted(JsonElement step) =>
        GetString(step, "status") is null or "DONE" or "ERROR";

    private static string? InferWorkspacePath(List<string> paths)
    {
        if (paths.Count == 0) return null;

        var dirs = new List<string[]>(paths.Count);
        foreach (var raw in paths)
        {
            try
            {
                var normalized = raw.Replace('/', '\\').TrimEnd('\\');
                var dir = Path.HasExtension(normalized) ? Path.GetDirectoryName(normalized) : normalized;
                if (string.IsNullOrWhiteSpace(dir)) continue;
                var parts = dir.Split('\\', StringSplitOptions.RemoveEmptyEntries);
                if (parts.Length >= 2) dirs.Add(parts);
            }
            catch
            {
                // Ignore malformed path strings inside tool arguments
            }
        }

        if (dirs.Count == 0) return null;

        // Compute longest common directory prefix across observed file paths
        var prefix = dirs[0];
        int commonLen = prefix.Length;
        for (int i = 1; i < dirs.Count; i++)
        {
            int limit = Math.Min(commonLen, dirs[i].Length);
            int matched = 0;
            while (matched < limit && string.Equals(prefix[matched], dirs[i][matched], StringComparison.OrdinalIgnoreCase))
            {
                matched++;
            }

            if (matched >= 2)
            {
                commonLen = matched;
            }
        }

        return commonLen >= 2 ? string.Join("\\", prefix.Take(commonLen)) : null;
    }

    private sealed class ToolMutableStat
    {
        public int CallCount;
        public int ErrorCount;
        public long ArgTokens;
        public long OutputTokens;
        public long MaxSingleOutput;
    }

    private static ToolMutableStat GetOrCreateToolStat(Dictionary<string, ToolMutableStat> map, string name)
    {
        if (!map.TryGetValue(name, out var stat))
        {
            stat = new ToolMutableStat();
            map[name] = stat;
        }

        return stat;
    }

    private static void AddCategory(Dictionary<string, long> categories, string key, long weight) =>
        categories[key] = categories.GetValueOrDefault(key) + weight;

    private static string ExtractTitle(string? content)
    {
        if (string.IsNullOrWhiteSpace(content)) return "Untitled Session";
        var match = UserRequestRegex().Match(content);
        var core = match.Success ? match.Groups[1].Value : content;
        var first = core
            .Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries)
            .Select(l => l.Trim())
            .FirstOrDefault(l => l.Length > 0 && !l.StartsWith('<'));
        if (string.IsNullOrEmpty(first)) return "Untitled Session";
        return first.Length > 84 ? first[..81] + "..." : first;
    }

    private static string Unquote(string value)
    {
        var trimmed = value.Trim();
        if (trimmed.Length >= 2 && trimmed[0] == '"' && trimmed[^1] == '"')
        {
            try
            {
                return JsonSerializer.Deserialize<string>(trimmed) ?? trimmed[1..^1];
            }
            catch
            {
                return trimmed[1..^1];
            }
        }

        return trimmed;
    }

    private static string? GetString(JsonElement el, string propName)
    {
        if (el.TryGetProperty(propName, out var prop) && prop.ValueKind == JsonValueKind.String)
        {
            return prop.GetString();
        }

        return null;
    }

    private static int? GetInt(JsonElement el, string propName)
    {
        if (el.TryGetProperty(propName, out var prop) && prop.ValueKind == JsonValueKind.Number && prop.TryGetInt32(out var v))
        {
            return v;
        }

        return null;
    }

    private static long? GetLong(JsonElement el, string propName)
    {
        if (el.TryGetProperty(propName, out var prop) && prop.ValueKind == JsonValueKind.Number && prop.TryGetInt64(out var v))
        {
            return v;
        }

        return null;
    }

    [GeneratedRegex("<truncated\\s+(\\d+)\\s+bytes>")]
    private static partial Regex TruncatedBytesRegex();

    [GeneratedRegex("<USER_REQUEST>\\s*([\\s\\S]*?)\\s*</USER_REQUEST>", RegexOptions.IgnoreCase)]
    private static partial Regex UserRequestRegex();

    [GeneratedRegex("\"conversationId\"\\s*:\\s*\"([a-zA-Z0-9-]+)\"")]
    private static partial Regex SubagentIdRegex();

}
