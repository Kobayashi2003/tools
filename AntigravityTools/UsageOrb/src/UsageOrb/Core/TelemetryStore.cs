using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace UsageOrb.Core;

public static class TelemetryStore
{
    private const int MaxHistoryPoints = 500;
    private const int MaxStoredConversations = 80;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        WriteIndented = true,
        Converters = { new JsonStringEnumConverter() },
    };

    private static T? ReadJsonSafe<T>(string path) where T : class
    {
        try
        {
            if (!File.Exists(path)) return null;
            using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            return JsonSerializer.Deserialize<T>(fs, JsonOptions);
        }
        catch
        {
            return null;
        }
    }

    private static void WriteJsonAtomic<T>(string path, T data)
    {
        var dir = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(dir))
        {
            Directory.CreateDirectory(dir);
        }

        var tmp = $"{path}.{Environment.ProcessId}.{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}.tmp";
        var json = JsonSerializer.Serialize(data, JsonOptions);
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
        var loaded = ReadJsonSafe<AppSettings>(AntigravityPaths.GetSettingsFilePath()) ?? new AppSettings();
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
        WriteJsonAtomic(AntigravityPaths.GetSettingsFilePath(), copy);
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

    public static string BuildCliStatusLineCommand(string exePath)
    {
        var normalized = exePath.Replace('\\', '/');
        return $"\"{normalized}\" --statusline";
    }

    public static bool IsCliStatusLineConfigured(string exePath)
    {
        try
        {
            var path = AntigravityPaths.GetCliSettingsFilePath();
            if (!File.Exists(path)) return false;
            var node = JsonNode.Parse(File.ReadAllText(path)) as JsonObject;
            var cmd = node?["statusLine"]?["command"]?.GetValue<string>();
            if (string.IsNullOrWhiteSpace(cmd)) return false;
            return cmd.Contains("--statusline", StringComparison.OrdinalIgnoreCase) &&
                   (cmd.Contains("UsageOrb", StringComparison.OrdinalIgnoreCase) ||
                    cmd.Contains(Path.GetFileName(exePath), StringComparison.OrdinalIgnoreCase));
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// Safely writes only the documented "statusLine" hook entry in ~/.gemini/antigravity-cli/settings.json,
    /// preserving all existing user settings. Only called on explicit user action.
    /// </summary>
    public static CliConfigResult ConfigureCliStatusLine(string exePath)
    {
        var settingsPath = AntigravityPaths.GetCliSettingsFilePath();
        try
        {
            JsonObject root;
            if (File.Exists(settingsPath))
            {
                var raw = File.ReadAllText(settingsPath);
                root = string.IsNullOrWhiteSpace(raw)
                    ? new JsonObject()
                    : (JsonNode.Parse(raw) as JsonObject
                       ?? throw new InvalidOperationException("CLI settings.json root is not a JSON object."));
            }
            else
            {
                root = new JsonObject();
            }

            root["statusLine"] = new JsonObject
            {
                ["type"] = "command",
                ["command"] = BuildCliStatusLineCommand(exePath),
            };

            var dir = Path.GetDirectoryName(settingsPath);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);

            var tmp = $"{settingsPath}.{Environment.ProcessId}.{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}.tmp";
            File.WriteAllText(tmp, root.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
            try
            {
                File.Move(tmp, settingsPath, overwrite: true);
            }
            catch
            {
                try { File.Copy(tmp, settingsPath, overwrite: true); }
                finally { try { File.Delete(tmp); } catch { /* ignore */ } }
            }

            return new CliConfigResult(true, settingsPath, "Configured statusLine in Antigravity CLI settings.json. Run agy to sync live quotas.");
        }
        catch (Exception ex)
        {
            return new CliConfigResult(false, settingsPath, $"Failed to update CLI settings.json: {ex.Message}");
        }
    }

    public static StatusLineStateFile? LoadStatusLineState() =>
        ReadJsonSafe<StatusLineStateFile>(AntigravityPaths.GetStatusLineStateFilePath());

    public static StatusLineStateFile RecordStatusLineSnapshot(RawStatusLinePayload payload, DateTimeOffset? now = null)
    {
        var path = Path.GetFullPath(AntigravityPaths.GetStatusLineStateFilePath());
        var pathHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(path.ToUpperInvariant())));
        using var mutex = new Mutex(false, $"Local\\UsageOrb.StatusLine.{pathHash}");
        try
        {
            if (!mutex.WaitOne(TimeSpan.FromSeconds(2))) throw new IOException("The UsageOrb status line state is busy.");
        }
        catch (AbandonedMutexException)
        {
            // Ownership was transferred after the previous writer exited.
        }

        try
        {
            return RecordStatusLineSnapshot(path, payload, now ?? DateTimeOffset.UtcNow);
        }
        finally
        {
            mutex.ReleaseMutex();
        }
    }

    private static StatusLineStateFile RecordStatusLineSnapshot(string path, RawStatusLinePayload payload, DateTimeOffset ts)
    {
        var state = ReadJsonSafe<StatusLineStateFile>(path) ?? new StatusLineStateFile();
        if (state.LatestQuota is null && state.Latest?.Payload.Quota is { Count: > 0 })
        {
            state.LatestQuota = state.Latest;
        }
        state.UpdatedAt = ts;
        state.Latest = new CapturedStatusLine { CapturedAt = ts, Payload = payload };

        var convId = !string.IsNullOrWhiteSpace(payload.ConversationId)
            ? payload.ConversationId!
            : payload.SessionId;
        if (!string.IsNullOrWhiteSpace(convId))
        {
            state.ByConversation[convId] = new CapturedStatusLine { CapturedAt = ts, Payload = payload };
            if (state.ByConversation.Count > MaxStoredConversations)
            {
                var trimmed = state.ByConversation
                    .OrderByDescending(kv => kv.Value.CapturedAt)
                    .Take(MaxStoredConversations)
                    .ToDictionary(kv => kv.Key, kv => kv.Value);
                state.ByConversation = trimmed;
            }
        }

        if (payload.Quota is { Count: > 0 })
        {
            state.LatestQuota = state.Latest;
            AddQuotaHistory(state, state.Latest);
        }

        WriteJsonAtomic(path, state);
        return state;
    }

    internal static void AddQuotaHistory(StatusLineStateFile state, CapturedStatusLine snapshot)
    {
        if (snapshot.Payload.Quota is not { Count: > 0 } quotas) return;

        var ts = snapshot.CapturedAt;
        var compact = new Dictionary<string, QuotaHistoryBucketSample>(StringComparer.OrdinalIgnoreCase);
        foreach (var (id, bucket) in quotas)
        {
            if (bucket.Disabled != true && (bucket.RemainingFraction.HasValue || bucket.RemainingAmount.HasValue))
            {
                compact[id] = new QuotaHistoryBucketSample
                {
                    RemainingFraction = bucket.RemainingFraction,
                    RemainingAmount = bucket.RemainingAmount,
                };
            }
        }

        if (compact.Count > 0)
        {
            var prev = state.QuotaHistory.Count > 0 ? state.QuotaHistory[^1] : null;
            bool shouldAppend = prev is null ||
                                (ts - prev.CapturedAt).TotalSeconds >= 60 ||
                                !BucketsEqual(prev.Buckets, compact);

            if (shouldAppend)
            {
                state.QuotaHistory.Add(new QuotaHistoryPoint { CapturedAt = ts, Buckets = compact });
                if (state.QuotaHistory.Count > MaxHistoryPoints)
                {
                    state.QuotaHistory = state.QuotaHistory.Skip(state.QuotaHistory.Count - MaxHistoryPoints).ToList();
                }
            }
        }
    }

    public static IReadOnlyList<QuotaBucketStatus> BuildQuotaBucketStatuses(
        StatusLineStateFile? state,
        DateTimeOffset? now = null)
    {
        var lastQuota = state?.LatestQuota ?? state?.Latest;
        if (state is null || lastQuota?.Payload.Quota is not { Count: > 0 } quotaMap)
        {
            return [];
        }

        var current = now ?? DateTimeOffset.UtcNow;
        var capturedAt = lastQuota.CapturedAt;
        var history = state.QuotaHistory;
        var list = new List<QuotaBucketStatus>(quotaMap.Count);

        foreach (var (id, raw) in quotaMap)
        {
            double? remFrac = raw.RemainingFraction.HasValue
                ? Math.Clamp(raw.RemainingFraction.Value, 0, 1)
                : null;
            double? usedFrac = remFrac.HasValue ? Math.Clamp(1.0 - remFrac.Value, 0, 1) : null;

            DateTimeOffset? resetTime = null;
            if (!string.IsNullOrWhiteSpace(raw.ResetTime) && DateTimeOffset.TryParse(raw.ResetTime, out var parsedReset))
            {
                resetTime = parsedReset;
            }

            double? burnRatePerHour = null;
            DateTimeOffset? projectedExhaustion = null;
            bool? willExhaustBeforeReset = null;

            if (remFrac.HasValue && history.Count >= 2)
            {
                var cutoff = current.AddHours(-5);
                var points = new List<(DateTimeOffset Ts, double Frac)>();
                foreach (var h in history)
                {
                    if (h.CapturedAt >= cutoff &&
                        h.Buckets.TryGetValue(id, out var sample) &&
                        sample.RemainingFraction.HasValue)
                    {
                        points.Add((h.CapturedAt, sample.RemainingFraction.Value));
                    }
                }

                if (points.Count >= 2)
                {
                    var newest = points[^1];
                    var oldest = newest;
                    for (int i = points.Count - 2; i >= 0; i--)
                    {
                        var cur = points[i];
                        if (cur.Frac + 0.005 < oldest.Frac)
                        {
                            // Quota window reset occurred after cur; stop scanning backwards
                            break;
                        }

                        oldest = cur;
                    }

                    double elapsedHours = (newest.Ts - oldest.Ts).TotalHours;
                    double deltaUsed = oldest.Frac - newest.Frac;
                    if (elapsedHours >= 0.05 && deltaUsed > 0.0005)
                    {
                        burnRatePerHour = deltaUsed / elapsedHours;
                        if (remFrac.Value > 0 && burnRatePerHour.Value > 0)
                        {
                            double hoursLeft = remFrac.Value / burnRatePerHour.Value;
                            if (hoursLeft < 24 * 14)
                            {
                                projectedExhaustion = current.AddHours(hoursLeft);
                            }
                        }
                    }
                }
            }

            var status = new QuotaBucketStatus(
                id,
                raw.DisplayLabel ?? ModelCatalog.FormatQuotaBucketLabel(id),
                ModelCatalog.InferQuotaGroupFromBucketId(id),
                remFrac,
                usedFrac,
                raw.RemainingAmount,
                resetTime,
                raw.ResetInSeconds,
                raw.Disabled == true,
                capturedAt,
                burnRatePerHour,
                projectedExhaustion,
                null)
            {
                PoolName = raw.PoolName,
                Window = raw.Window,
            };

            var liveResetSec = status.GetLiveResetInSeconds(current);
            if (projectedExhaustion.HasValue)
            {
                if (resetTime.HasValue)
                {
                    willExhaustBeforeReset = projectedExhaustion.Value < resetTime.Value;
                }
                else if (liveResetSec.HasValue)
                {
                    willExhaustBeforeReset = projectedExhaustion.Value < current.AddSeconds(liveResetSec.Value);
                }
            }

            list.Add(status with { WillExhaustBeforeReset = willExhaustBeforeReset });
        }

        return list
            .OrderBy(b => b.RemainingFraction ?? 2.0)
            .ToList();
    }

    private static bool BucketsEqual(
        Dictionary<string, QuotaHistoryBucketSample> a,
        Dictionary<string, QuotaHistoryBucketSample> b)
    {
        if (a.Count != b.Count) return false;
        foreach (var (k, va) in a)
        {
            if (!b.TryGetValue(k, out var vb)) return false;
            if (va.RemainingFraction != vb.RemainingFraction || va.RemainingAmount != vb.RemainingAmount)
                return false;
        }

        return true;
    }
}
