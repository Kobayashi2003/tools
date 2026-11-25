using System.IO;
using System.Text;
using System.Text.Json;

namespace UsageOrb.Core;

/// <summary>
/// Implements `UsageOrb.exe --statusline` for Antigravity CLI (`/statusline`).
/// Reads the official CLI state JSON from stdin, persists live quota snapshots for the
/// floating orb &amp; console, and outputs a compact 2-line ANSI telemetry bar.
/// </summary>
public static class StatusLineRunner
{
    private const string Reset = "\x1b[0m";
    private const string Bold = "\x1b[1m";
    private const string Dim = "\x1b[2m";
    private const string Cyan = "\x1b[36m";
    private const string Green = "\x1b[32m";
    private const string Yellow = "\x1b[33m";
    private const string Red = "\x1b[31m";
    private const string Magenta = "\x1b[35m";

    private static readonly JsonSerializerOptions ReadOptions = new()
    {
        PropertyNameCaseInsensitive = true,
    };

    public static int RunFromStdio()
    {
        try
        {
            using var reader = new StreamReader(Console.OpenStandardInput(), Encoding.UTF8);
            var raw = reader.ReadToEnd().Trim();
            if (string.IsNullOrEmpty(raw)) return 0;

            var payload = JsonSerializer.Deserialize<RawStatusLinePayload>(raw, ReadOptions);
            if (payload is null) return 0;

            try
            {
                TelemetryStore.RecordStatusLineSnapshot(payload);
            }
            catch
            {
                // Never fail statusline rendering if disk write fails transiently
            }

            var output = RenderAnsi(payload);
            using var writer = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
            writer.WriteLine(output);
            writer.Flush();
            return 0;
        }
        catch
        {
            // Fail silently so Antigravity CLI never trips its consecutive-failure limit
            return 0;
        }
    }

    public static string RenderAnsi(RawStatusLinePayload payload)
    {
        int width = payload.TerminalWidth is > 0 ? payload.TerminalWidth.Value : 110;
        bool compact = width < 84;

        var line1 = new List<string>
        {
            FormatStateBadge(payload.AgentState),
            $"{Bold}{payload.Model?.DisplayName ?? payload.Model?.Id ?? "No model"}{Reset}",
        };

        if (payload.ContextWindow is { } cw && cw.GetUsedPercentage() is double usedPct)
        {
            string col = ColorForUsage(usedPct);
            long winSize = cw.ContextWindowSize ?? 0;
            string bar = FormatUtil.ProgressBar(usedPct, compact ? 8 : 12);

            long cacheDenom = cw.CurrentUsage is { } cu2 ? (cu2.InputTokens ?? 0) + (cu2.CacheReadInputTokens ?? 0) : 0;
            string cacheText = cw.CurrentUsage is { } cu3 && cacheDenom > 0
                ? $" {Dim}cache {(int)Math.Round((double)(cu3.CacheReadInputTokens ?? 0) / cacheDenom * 100)}%{Reset}"
                : "";
            string tokLabel = winSize > 0
                ? $" ~{FormatUtil.Tokens(usedPct / 100 * winSize)}/{FormatUtil.Tokens(winSize)}" : "";
            string over200k = payload.Exceeds200kTokens == true ? $" {Yellow}>200K{Reset}" : "";

            line1.Add($"CTX {col}{bar} {usedPct:F1}%{Reset}{tokLabel}{cacheText}{over200k}");
        }

        if (payload.Cost?.TotalUsd is { } usd)
        {
            line1.Add($"{Dim}{FormatUtil.Usd(usd)}{Reset}");
        }

        if (!compact)
        {
            var extras = new List<string>();
            if (!string.IsNullOrEmpty(payload.CycleMode)) extras.Add($"{Yellow}{payload.CycleMode}{Reset}");
            if (payload.Sandbox?.Enabled == true) extras.Add($"{Green}sandbox{Reset}");
            if (payload.ArtifactCount is > 0) extras.Add($"art:{payload.ArtifactCount}");
            if (payload.TaskCount is > 0) extras.Add($"tasks:{payload.TaskCount}");
            if (payload.Subagents is { Count: > 0 } subs)
            {
                int running = subs.Count(s => string.Equals(s.Status, "running", StringComparison.OrdinalIgnoreCase));
                extras.Add($"sub:{running}/{subs.Count}");
            }

            if (extras.Count > 0) line1.Add($"{Dim}{string.Join(' ', extras)}{Reset}");
        }

        var lines = new List<string> { string.Join($" {Dim}│{Reset} ", line1) };

        var line2 = new List<string>();
        if (!string.IsNullOrWhiteSpace(payload.PlanTier))
        {
            line2.Add($"{Cyan}{payload.PlanTier}{Reset}");
        }

        if (payload.Quota is { Count: > 0 })
        {
            foreach (var (id, b) in payload.Quota)
            {
                if (b.Disabled == true) continue;
                var label = ModelCatalog.FormatQuotaBucketLabel(id);
                if (b.RemainingFraction.HasValue)
                {
                    double remPct = Math.Clamp(b.RemainingFraction.Value * 100.0, 0, 100);
                    string col = ColorForRemaining(remPct);
                    string bar = compact ? "" : FormatUtil.ProgressBar(remPct, 8) + " ";
                    string reset = b.ResetInSeconds.HasValue ? $" {Dim}↻{FormatUtil.Duration((long)b.ResetInSeconds.Value)}{Reset}" : "";
                    line2.Add($"{label}: {col}{bar}{remPct:F1}%{Reset}{reset}");
                }
                else if (b.RemainingAmount.HasValue)
                {
                    line2.Add($"{label}: {Cyan}{b.RemainingAmount.Value:0.##}{Reset}");
                }
            }
        }

        if (!compact && payload.ContextWindow is { } cw2 && ((cw2.TotalInputTokens ?? 0) > 0 || (cw2.TotalOutputTokens ?? 0) > 0))
        {
            line2.Add($"{Dim}Σ In:{FormatUtil.Tokens(cw2.TotalInputTokens ?? 0)} Out:{FormatUtil.Tokens(cw2.TotalOutputTokens ?? 0)}{Reset}");
        }

        if (line2.Count > 0)
        {
            lines.Add(string.Join($" {Dim}│{Reset} ", line2));
        }

        return string.Join('\n', lines);
    }

    private static string ColorForUsage(double pct) => pct >= 85 ? Red : (pct >= 65 ? Yellow : Green);
    private static string ColorForRemaining(double pct) => pct <= 15 ? Red : (pct <= 35 ? Yellow : Green);

    private static string FormatStateBadge(string? state) => state switch
    {
        "working" => $"{Cyan}● WORKING{Reset}",
        "tool_use" => $"{Magenta}⚙ TOOL{Reset}",
        "reviewing" => $"{Yellow}◈ REVIEW{Reset}",
        "error" => $"{Red}✖ ERROR{Reset}",
        "idle" => $"{Green}● READY{Reset}",
        _ => $"{Dim}● {(state ?? "ACTIVE").ToUpperInvariant()}{Reset}",
    };
}
