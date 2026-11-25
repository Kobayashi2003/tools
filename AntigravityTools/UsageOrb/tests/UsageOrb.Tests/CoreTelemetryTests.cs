using System.Diagnostics;
using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using UsageOrb.Core;
using Xunit;

namespace UsageOrb.Tests;

[CollectionDefinition("EnvIsolated", DisableParallelization = true)]
public sealed class EnvIsolatedCollection;

[Collection("EnvIsolated")]
public sealed class CoreTelemetryTests : IDisposable
{
    private readonly string _tmpDir;
    private readonly Dictionary<string, string?> _origEnv = new();

    public CoreTelemetryTests()
    {
        _tmpDir = Path.Combine(Path.GetTempPath(), $"usageorb-test-{Guid.NewGuid():N}");
        Directory.CreateDirectory(_tmpDir);

        SetEnv("USAGEORB_GEMINI_HOME", _tmpDir);
        SetEnv("USAGEORB_DATA_DIR", Path.Combine(_tmpDir, "appdata"));
        SetEnv("USAGEORB_STATUSLINE_FILE", Path.Combine(_tmpDir, "statusline-state.json"));
        SetEnv("ANTIGRAVITY_APP_DATA_DIR", null);
        TranscriptParser.ClearCache();
    }

    private void SetEnv(string key, string? value)
    {
        if (!_origEnv.ContainsKey(key))
        {
            _origEnv[key] = Environment.GetEnvironmentVariable(key);
        }

        Environment.SetEnvironmentVariable(key, value);
    }

    public void Dispose()
    {
        foreach (var (k, v) in _origEnv)
        {
            Environment.SetEnvironmentVariable(k, v);
        }

        TranscriptParser.ClearCache();
        try
        {
            if (Directory.Exists(_tmpDir)) Directory.Delete(_tmpDir, recursive: true);
        }
        catch
        {
            // Ignore transient test cleanup lock
        }
    }

    private string WriteTranscript(string surfaceDir, string convId, object[] lines)
    {
        var dir = Path.Combine(_tmpDir, surfaceDir, "brain", convId, ".system_generated", "logs");
        Directory.CreateDirectory(dir);
        var sb = new StringBuilder();
        foreach (var line in lines)
        {
            sb.AppendLine(JsonSerializer.Serialize(line));
        }

        var path = Path.Combine(dir, "transcript.jsonl");
        File.WriteAllText(path, sb.ToString());
        return path;
    }

    [Fact]
    public void FollowsDesktopWindowTitlesWithoutNewTranscriptWrites()
    {
        var now = DateTimeOffset.Parse("2026-11-22T10:00:00Z");
        var older = WriteTranscript("antigravity", "chat-a",
        [
            new { type = "USER_INPUT", content = "First prompt with unrelated wording" },
            new { type = "PLANNER_RESPONSE", model = "gemini-4-neon-high", input_tokens = 95_000 },
        ]);
        var newer = WriteTranscript("antigravity", "chat-b",
        [
            new { type = "USER_INPUT", content = "Second prompt with unrelated wording" },
            new { type = "PLANNER_RESPONSE", model = "gemini-4-neon-high", input_tokens = 240_000 },
        ]);
        File.SetLastWriteTimeUtc(older, now.AddHours(-1).UtcDateTime);
        File.SetLastWriteTimeUtc(newer, now.UtcDateTime);

        CreateConversationSummaryDatabase("""
            CREATE TABLE conversation_summaries (conversation_id TEXT, title TEXT, parent_conversation_id TEXT, last_modified_time TEXT, workspace_uris TEXT);
            INSERT INTO conversation_summaries VALUES
              ('chat-a', 'Investigate compaction metrics', '', '2026-11-22T09:00:00Z', '[]'),
              ('chat-b', 'Verify refund instrumentation', '', '2026-11-22T10:00:00Z', '[]');
            """);

        var snapshot = AnalyticsEngine.Collect(new AppSettings(), now: now);
        Assert.Equal("chat-b", snapshot.ActiveSession?.ConversationId);
        var a = SessionResolver.Resolve(snapshot, null, "Investigate compaction me...").Session;
        var b = SessionResolver.Resolve(snapshot, null, "Verify refund instrumenta...").Session;
        Assert.Equal("chat-a", a?.ConversationId);
        Assert.Equal(95_000, a?.CurrentContextTokens);
        Assert.Equal("chat-b", b?.ConversationId);
        Assert.Equal(240_000, b?.CurrentContextTokens);
        var unknown = SessionResolver.Resolve(snapshot, null, "Antigravity", AntigravitySurface.App);
        Assert.Equal(SessionBindSource.UnmatchedWindow, unknown.Source);
        Assert.Null(unknown.Session);
    }

    [Fact]
    public void UsesCliPercentageForActiveConversationEvenBeforeTranscriptExists()
    {
        var now = DateTimeOffset.Parse("2026-11-22T10:00:00Z");
        TelemetryStore.RecordStatusLineSnapshot(new RawStatusLinePayload
        {
            ConversationId = "cli-without-log",
            ConversationTitle = "CLI conversation",
            Model = new() { Id = "gemini-4-argon-medium" },
            ContextWindow = new()
            {
                ContextWindowSize = 1_048_576,
                UsedPercentage = 14.24,
                CurrentUsage = new() { InputTokens = 63_382, CacheReadInputTokens = 20_857 },
            },
        }, now);

        var snapshot = AnalyticsEngine.Collect(new AppSettings(), now: now);
        var session = Assert.Single(snapshot.Sessions);
        Assert.Equal("cli-without-log", snapshot.ActiveSession?.ConversationId);
        Assert.Equal(AntigravitySurface.Cli, session.Surface);
        Assert.Equal(14.24, session.ContextUsedPercent, 2);
    }

    [Fact]
    public void UsesCompletedContextAndIncludesCachedInputInCompaction()
    {
        var now = DateTimeOffset.Parse("2026-11-22T10:00:00Z");
        WriteTranscript("antigravity", "compact-chat",
        [
            new { type = "PLANNER_RESPONSE", status = "DONE", model = "gemini-4-neon-high", input_tokens = 8_000, cache_read_tokens = 502_000 },
            new { type = "CHECKPOINT", status = "DONE", input_tokens = 6_000, cache_read_tokens = 504_000, output_tokens = 4_500 },
            new { type = "PLANNER_RESPONSE", status = "RUNNING", model = "gemini-4-argon-medium" },
        ]);

        var snapshot = AnalyticsEngine.Collect(new AppSettings(), now: now);
        var session = Assert.Single(snapshot.Sessions);
        Assert.Equal(4_500, session.CurrentContextTokens);
        Assert.Equal("gemini-4-neon-high", session.PrimaryModelId);
        Assert.Equal(505_500, Assert.Single(session.Compactions).FreedTokens);
    }

    [Fact]
    public void DoesNotInferQuotaPeriodFromResetCountdownOrShowExpiredLiveQuota()
    {
        var now = DateTimeOffset.Parse("2026-11-22T10:00:00Z");
        TelemetryStore.RecordStatusLineSnapshot(new RawStatusLinePayload
        {
            Quota = new()
            {
                ["gemini-weekly"] = new() { RemainingFraction = 0.63, ResetInSeconds = 300 },
                ["flash"] = new() { RemainingFraction = 0.91, ResetInSeconds = 600 },
                ["gemini-5h"] = new() { RemainingFraction = 0.8, Disabled = true },
            },
        }, now);
        TelemetryStore.RecordStatusLineSnapshot(new RawStatusLinePayload { ConversationId = "another-chat" }, now.AddSeconds(1));

        var settings = new AppSettings();
        var snapshot = AnalyticsEngine.Collect(settings, now: now.AddSeconds(1));
        var (fiveHour, weekly) = QuotaResolver.Resolve(snapshot, settings, now.AddSeconds(1));
        Assert.False(fiveHour.IsLive);
        Assert.Null(fiveHour.RemainingPercent);
        Assert.Equal(63, weekly.RemainingPercent);
        Assert.False(QuotaResolver.Resolve(snapshot, settings, now.AddMinutes(6)).Weekly.IsLive);
    }

    [Fact]
    public async Task ReadsDesktopQuotaOverTheRegisteredLoopbackConnection()
    {
        const string body = """
            {"response":{"groups":[
              {"displayName":"Gemini Models","buckets":[
                {"bucketId":"gemini-5h","remainingFraction":0.55,"window":"5h"},
                {"bucketId":"gemini-weekly","remaining":{"remainingFraction":0},"window":"weekly"}]},
              {"displayName":"Claude and GPT models","buckets":[
                {"bucketId":"3p-5h","remainingFraction":0.97,"window":"5h"},
                {"bucketId":"3p-weekly","remainingFraction":0.71,"window":"weekly"}]},
              {"displayName":"Gemini 4 Argon","buckets":[
                {"bucketId":"gemini-argon-wtu-weekly","remainingFraction":0.82,"window":"weekly"}]}
            ]}}
            """;

        using var rsa = RSA.Create(2048);
        var request = new CertificateRequest("CN=Local Desktop Fixture", rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        using var generated = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(1));
        using var certificate = new X509Certificate2(generated.Export(X509ContentType.Pfx));
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var responseTask = SendDesktopQuotaFixture(listener, certificate, body, timeout.Token);
        var server = new DesktopQuotaClient.Registration
        {
            Pid = Environment.ProcessId,
            HttpsPort = ((IPEndPoint)listener.LocalEndpoint).Port,
            CsrfToken = "fixture-token",
            LsVersion = "2.34.0",
        };
        var readTask = DesktopQuotaClient.ReadAsync(server, timeout.Token);
        await Task.WhenAll(responseTask, readTask);
        var payload = await readTask;
        Assert.NotNull(payload);

        var now = DateTimeOffset.Parse("2026-11-23T10:00:00Z");
        var settings = new AppSettings();
        WriteTranscript("antigravity", "gemini", [new { type = "PLANNER_RESPONSE", model = "gemini-4-neon-high", input_tokens = 100 }]);
        WriteTranscript("antigravity", "claude", [new { type = "PLANNER_RESPONSE", model = "claude-opus-5-5-high", input_tokens = 100 }]);
        WriteTranscript("antigravity", "argon", [new { type = "PLANNER_RESPONSE", model = "gemini-4-argon-medium", input_tokens = 100 }]);
        TelemetryStore.RecordStatusLineSnapshot(new RawStatusLinePayload
        {
            Quota = new() { ["gemini-weekly"] = new() { RemainingFraction = 0.9 } },
        }, now);

        var desktop = new StatusLineStateFile
        {
            LatestQuota = new CapturedStatusLine { CapturedAt = now, Payload = payload },
        };
        var snapshot = AnalyticsEngine.Collect(settings, now, desktop);
        Assert.Equal(now, snapshot.DesktopQuotaLastSeenAt);
        var (gemini5h, geminiWeek) = QuotaResolver.Resolve(snapshot, settings, now, snapshot.Sessions.Single(s => s.ConversationId == "gemini"));
        var (claude5h, claudeWeek) = QuotaResolver.Resolve(snapshot, settings, now, snapshot.Sessions.Single(s => s.ConversationId == "claude"));
        var (_, argonWeek) = QuotaResolver.Resolve(snapshot, settings, now, snapshot.Sessions.Single(s => s.ConversationId == "argon"));
        Assert.Equal(55, gemini5h.RemainingPercent!.Value, 2);
        Assert.Equal(0, geminiWeek.RemainingPercent);
        Assert.Equal(97, claude5h.RemainingPercent);
        Assert.Equal(71, claudeWeek.RemainingPercent);
        Assert.Equal(82, argonWeek.RemainingPercent!.Value, 2);
    }

    private static async Task SendDesktopQuotaFixture(TcpListener listener, X509Certificate2 certificate, string json, CancellationToken cancellationToken)
    {
        using var client = await listener.AcceptTcpClientAsync(cancellationToken);
        using var tls = new SslStream(client.GetStream());
        await tls.AuthenticateAsServerAsync(new SslServerAuthenticationOptions { ServerCertificate = certificate }, cancellationToken);
        using var reader = new StreamReader(tls, Encoding.UTF8, leaveOpen: true);
        var request = await reader.ReadLineAsync(cancellationToken);
        Assert.NotNull(request);
        Assert.Contains("/RetrieveUserQuotaSummary", request);
        var headerFound = false;
        while (await reader.ReadLineAsync(cancellationToken) is { Length: > 0 } header)
        {
            if (header.Equals("X-Codeium-Csrf-Token: fixture-token", StringComparison.OrdinalIgnoreCase)) headerFound = true;
        }
        Assert.True(headerFound);
        var response = $"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {Encoding.UTF8.GetByteCount(json)}\r\nConnection: close\r\n\r\n{json}";
        await tls.WriteAsync(Encoding.UTF8.GetBytes(response), cancellationToken);
    }

    private void CreateConversationSummaryDatabase(string sql)
    {
        var path = Path.Combine(_tmpDir, "antigravity", "conversation_summaries.db");
        Assert.Equal(0, SqliteOpen(path, out var db));
        try
        {
            Assert.Equal(0, SqliteExec(db, sql, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero));
        }
        finally
        {
            SqliteClose(db);
        }
    }

    [System.Runtime.InteropServices.DllImport("winsqlite3.dll", EntryPoint = "sqlite3_open16")]
    private static extern int SqliteOpen([System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.LPWStr)] string path, out IntPtr db);

    [System.Runtime.InteropServices.DllImport("winsqlite3.dll", EntryPoint = "sqlite3_exec")]
    private static extern int SqliteExec(IntPtr db, string sql, IntPtr callback, IntPtr argument, IntPtr error);

    [System.Runtime.InteropServices.DllImport("winsqlite3.dll", EntryPoint = "sqlite3_close")]
    private static extern int SqliteClose(IntPtr db);

    [Fact]
    public void ResolvesDocumentedModelSpecsAndContextLimits()
    {
        var neon = ModelCatalog.Resolve("gemini-4-neon-xhigh");
        Assert.Equal(524_288, neon.ContextWindow);
        Assert.Equal(QuotaGroupId.GeminiPro, neon.QuotaGroup);
        Assert.Equal("xhigh", neon.Effort);

        var argon = ModelCatalog.Resolve("gemini-4-argon-medium");
        Assert.Equal(1_048_576, argon.ContextWindow);

        var flash = ModelCatalog.Resolve("gemini-3.8-flash-high");
        Assert.Equal(QuotaGroupId.GeminiFlash, flash.QuotaGroup);
        Assert.Equal(1_048_576, flash.ContextWindow);

        var claude = ModelCatalog.Resolve("claude-opus-5-5-high");
        Assert.Equal(QuotaGroupId.PartnerClaudeGpt, claude.QuotaGroup);
        Assert.Equal(200_000, claude.ContextWindow);
    }

    [Fact]
    public void EstimatesTokensIncludingTruncationMarkers()
    {
        Assert.True(TranscriptParser.EstimateTextTokens("hello world") > 0);
        long withTrunc = TranscriptParser.EstimateTextTokens("preview <truncated 7200 bytes> tail");
        Assert.True(withTrunc > 1900);
    }

    [Fact]
    public void ParsesTranscriptsWithCompactionsToolBloatAndSubagentRollups()
    {
        var now = DateTimeOffset.Parse("2026-11-22T10:00:00Z");
        const string parentId = "11111111-2222-3333-4444-555555555555";
        const string childId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

        WriteTranscript("antigravity", childId,
        [
            new { step_index = 0, source = "USER_EXPLICIT", type = "USER_INPUT", status = "DONE", created_at = "2026-11-22T09:10:00Z", content = "Subagent research task" },
            new { step_index = 1, source = "MODEL", type = "PLANNER_RESPONSE", status = "DONE", created_at = "2026-11-22T09:11:00Z", model = "gemini-3.8-flash-high", input_tokens = 15000, cache_read_tokens = 5000, output_tokens = 1200, content = "Finished." },
        ]);

        WriteTranscript("antigravity", parentId,
        [
            new { step_index = 0, source = "USER_EXPLICIT", type = "USER_INPUT", status = "DONE", created_at = "2026-11-22T08:00:00Z", content = "<USER_REQUEST>\nAnalyze context footprint and quota burn\n</USER_REQUEST>" },
            new { step_index = 1, source = "MODEL", type = "PLANNER_RESPONSE", status = "DONE", created_at = "2026-11-22T08:01:00Z", model = "gemini-4-neon-high", input_tokens = 14000, cache_read_tokens = 0, output_tokens = 600, thinking = "Reviewing architecture.", tool_calls = new[] { new { name = "read_file", args = new { Path = "\"README.md\"" } } } },
            new { step_index = 2, source = "MODEL", type = "GENERIC", status = "DONE", created_at = "2026-11-22T08:01:05Z", content = "File content <truncated 40000 bytes>" },
            new { step_index = 3, source = "SYSTEM", type = "CHECKPOINT", status = "DONE", created_at = "2026-11-22T09:00:00Z", input_tokens = 510000, cache_read_tokens = 0, output_tokens = 4500, content = "# Resuming from a compaction\nSummary of prior turns." },
            new { step_index = 4, source = "MODEL", type = "PLANNER_RESPONSE", status = "DONE", created_at = "2026-11-22T09:05:00Z", model = "gemini-4-neon-high", input_tokens = 18000, cache_read_tokens = 0, output_tokens = 800, tool_calls = new[] { new { name = "invoke_subagent", args = new { Role = "\"Codebase Researcher\"", TypeName = "\"research\"", Model = "\"flash\"" } } } },
            new { step_index = 5, source = "MODEL", type = "GENERIC", status = "DONE", created_at = "2026-11-22T09:05:02Z", content = $"Created the following subagent:\n{{\n  \"conversationId\": \"{childId}\"\n}}" },
            new { step_index = 6, source = "MODEL", type = "PLANNER_RESPONSE", status = "DONE", created_at = "2026-11-22T09:20:00Z", model = "gemini-4-neon-high", input_tokens = 6000, cache_read_tokens = 18000, output_tokens = 500, content = "Done." },
        ]);

        var snap = AnalyticsEngine.Collect(new AppSettings(), now: now);

        Assert.Equal(2, snap.Sessions.Count);
        Assert.NotNull(snap.ActiveSession);
        Assert.Equal(parentId, snap.ActiveSession!.ConversationId);
        Assert.Equal("Analyze context footprint and quota burn", snap.ActiveSession.Title);
        Assert.Equal(24_000, snap.ActiveSession.CurrentContextTokens);
        Assert.Equal(1, snap.ActiveSession.CompactionCount);
        Assert.Equal(505_500, snap.ActiveSession.Compactions[0].FreedTokens);
        Assert.Single(snap.ActiveSession.Subagents);
        Assert.True(snap.ActiveSession.Subagents[0].FoundTranscript);
        Assert.Equal(14000 + 18000 + 6000 + 15000, snap.ActiveSession.RolledUpTotals.InputTokens);

        long catSum = snap.ActiveSession.Categories.Sum(c => c.Tokens);
        Assert.InRange(Math.Abs(catSum - 24_000), 0, 5);

        Assert.True(snap.Windows[WindowKey.FiveHours].CacheSavedUsd > 0);
        Assert.True(snap.SprintVsWeeklyPaceRatio > 0);
        var groups = snap.Windows[WindowKey.FiveHours].ByQuotaGroup.Select(g => g.GroupId).OrderBy(x => x).ToArray();
        Assert.Equal(new[] { QuotaGroupId.GeminiPro, QuotaGroupId.GeminiFlash }, groups);
    }

    [Fact]
    public void RecordsStatusLineSnapshotsCalculatesBurnRateAndRendersAnsi()
    {
        var t1 = DateTimeOffset.Parse("2026-11-22T08:00:00Z");
        var t2 = DateTimeOffset.Parse("2026-11-22T10:00:00Z");

        TelemetryStore.RecordStatusLineSnapshot(new RawStatusLinePayload
        {
            ConversationId = "conv-sl",
            PlanTier = "Pro",
            Email = "dev@example.com",
            Quota = new Dictionary<string, RawStatusLineQuotaBucket>
            {
                ["gemini-weekly"] = new() { RemainingFraction = 0.90, ResetTime = "2026-11-29T00:00:00Z", ResetInSeconds = 560000 },
                ["ai-credits"] = new() { RemainingAmount = 42 },
            },
            ContextWindow = new RawStatusLineContextWindow
            {
                ContextWindowSize = 1_048_576,
                UsedPercentage = 14.2,
                TotalInputTokens = 90_000,
                TotalOutputTokens = 12_000,
                CurrentUsage = new RawStatusLineCurrentUsage { InputTokens = 60_000, CacheReadInputTokens = 80_000, OutputTokens = 500 },
            },
        }, t1);

        var state = TelemetryStore.RecordStatusLineSnapshot(new RawStatusLinePayload
        {
            ConversationId = "conv-sl",
            PlanTier = "Pro",
            Email = "dev@example.com",
            Quota = new Dictionary<string, RawStatusLineQuotaBucket>
            {
                ["gemini-weekly"] = new() { RemainingFraction = 0.80, ResetTime = "2026-11-29T00:00:00Z", ResetInSeconds = 552800 },
                ["ai-credits"] = new() { RemainingAmount = 42 },
            },
        }, t2);

        var buckets = TelemetryStore.BuildQuotaBucketStatuses(state, t2);
        var weekly = buckets.First(b => b.Id == "gemini-weekly");
        Assert.NotNull(weekly.RemainingFraction);
        Assert.Equal(0.80, weekly.RemainingFraction!.Value, 3);
        Assert.NotNull(weekly.BurnRatePerHour);
        Assert.Equal(0.05, weekly.BurnRatePerHour!.Value, 3);
        Assert.True(weekly.WillExhaustBeforeReset);

        var ansi = StatusLineRunner.RenderAnsi(state.Latest!.Payload);
        Assert.Contains("80.0%", ansi);
        Assert.Contains("Pro", ansi);
    }

    [Fact]
    public void CompiledWinExeSupportsHeadlessStatusLineStdioMode()
    {
        var exePath = Path.Combine(AppContext.BaseDirectory, "UsageOrb.exe");
        Assert.True(File.Exists(exePath), $"Expected UsageOrb.exe at {exePath}");

        var psi = new ProcessStartInfo
        {
            FileName = exePath,
            Arguments = "--statusline",
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardInputEncoding = Encoding.UTF8,
            StandardOutputEncoding = Encoding.UTF8,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        psi.Environment["USAGEORB_STATUSLINE_FILE"] = Path.Combine(_tmpDir, "cli-stdio-state.json");

        using var proc = Process.Start(psi)!;
        var sampleJson = """
            {
              "agent_state": "idle",
              "plan_tier": "Pro",
              "model": { "id": "gemini-4-neon-xhigh", "display_name": "Gemini 4 Neon (XHigh)" },
              "context_window": {
                "context_window_size": 524288,
                "used_percentage": 45.3,
                "total_input_tokens": 252000,
                "total_output_tokens": 103800,
                "current_usage": { "input_tokens": 14000, "cache_read_input_tokens": 223559, "output_tokens": 800 }
              },
              "quota": {
                "gemini-weekly": { "remaining_fraction": 0.9378, "reset_in_seconds": 560580 },
                "gemini-5h": { "remaining_fraction": 0.72, "reset_in_seconds": 10800 }
              },
              "terminal_width": 115
            }
            """;

        proc.StandardInput.Write(sampleJson);
        proc.StandardInput.Close();

        string stdout = proc.StandardOutput.ReadToEnd();
        Assert.True(proc.WaitForExit(8000));
        Assert.Equal(0, proc.ExitCode);
        Assert.Contains("Gemini 4 Neon (XHigh)", stdout);
        Assert.Contains("93.8%", stdout);
        Assert.Contains("72.0%", stdout);
        Assert.True(File.Exists(Path.Combine(_tmpDir, "cli-stdio-state.json")));
    }

    [Fact]
    public void ResolvesEstimatedAndLiveBigThreeQuotaSummaries()
    {
        var now = DateTimeOffset.Parse("2026-11-22T10:00:00Z");
        WriteTranscript("antigravity", "quota-est-conv",
        [
            new { step_index = 0, source = "USER_EXPLICIT", type = "USER_INPUT", status = "DONE", created_at = "2026-11-22T09:00:00Z", content = "Run build" },
            new { step_index = 1, source = "MODEL", type = "PLANNER_RESPONSE", status = "DONE", created_at = "2026-11-22T09:05:00Z", model = "gemini-4-neon-high", input_tokens = 20_000_000, cache_read_tokens = 0, output_tokens = 0, content = "Done." },
        ]);

        var settings = new AppSettings
        {
            FiveHourEstBaselineTokens = 80_000_000,
            WeeklyEstBaselineTokens = 200_000_000,
        };

        // 1. Before CLI sync: calibrated estimated remaining %
        var snapEst = AnalyticsEngine.Collect(settings, now: now);
        var (est5h, estWk) = QuotaResolver.Resolve(snapEst, settings, now);
        Assert.False(est5h.IsLive);
        Assert.False(estWk.IsLive);
        Assert.Equal("Est.", est5h.StatusBadge);
        Assert.Equal(75.0, est5h.RemainingPercent!.Value, 1);
        Assert.Equal(90.0, estWk.RemainingPercent!.Value, 1);

        // 2. After CLI sync: exact live backend fractions take priority
        TelemetryStore.RecordStatusLineSnapshot(new RawStatusLinePayload
        {
            PlanTier = "Pro",
            Quota = new Dictionary<string, RawStatusLineQuotaBucket>
            {
                ["gemini-5h"] = new() { RemainingFraction = 0.84, ResetInSeconds = 8280 },
                ["gemini-weekly"] = new() { RemainingFraction = 0.41, ResetInSeconds = 309600 },
            },
        }, now);

        var snapLive = AnalyticsEngine.Collect(settings, now: now);
        var (live5h, liveWk) = QuotaResolver.Resolve(snapLive, settings, now);
        Assert.True(live5h.IsLive);
        Assert.True(liveWk.IsLive);
        Assert.Equal(84.0, live5h.RemainingPercent!.Value, 1);
        Assert.Equal(41.0, liveWk.RemainingPercent!.Value, 1);
        Assert.Equal(8280L, live5h.ResetInSeconds);
        Assert.Equal(309600L, liveWk.ResetInSeconds);
    }

    [Fact]
    public void SafelyConfiguresCliStatusLinePreservingExistingSettingsAndParsesShorthand()
    {
        Assert.Equal(80_000_000L, FormatUtil.ParseTokenShorthand("80M"));
        Assert.Equal(500_000_000L, FormatUtil.ParseTokenShorthand("500m"));
        Assert.Equal(1_200_000_000L, FormatUtil.ParseTokenShorthand("1.2B"));
        Assert.Equal(524_000L, FormatUtil.ParseTokenShorthand("524K"));
        Assert.Equal("80M", FormatUtil.TokensCompact(80_000_000));
        Assert.Equal("500M", FormatUtil.TokensCompact(500_000_000));

        // Seed an existing CLI settings.json with unrelated user preferences
        var cliPath = AntigravityPaths.GetCliSettingsFilePath();
        Directory.CreateDirectory(Path.GetDirectoryName(cliPath)!);
        File.WriteAllText(cliPath, """{ "theme": "dark", "model": "gemini-4-neon-high" }""");

        Assert.False(TelemetryStore.IsCliStatusLineConfigured(@"D:\Tools\UsageOrb.exe"));

        var res = TelemetryStore.ConfigureCliStatusLine(@"D:\Tools\UsageOrb.exe");
        Assert.True(res.Success);
        Assert.True(TelemetryStore.IsCliStatusLineConfigured(@"D:\Tools\UsageOrb.exe"));

        using var doc = JsonDocument.Parse(File.ReadAllText(cliPath));
        Assert.Equal("dark", doc.RootElement.GetProperty("theme").GetString());
        Assert.Equal("gemini-4-neon-high", doc.RootElement.GetProperty("model").GetString());
        Assert.Equal("command", doc.RootElement.GetProperty("statusLine").GetProperty("type").GetString());
        Assert.Equal("\"D:/Tools/UsageOrb.exe\" --statusline", doc.RootElement.GetProperty("statusLine").GetProperty("command").GetString());
    }

    [Fact]
    public void ResolvesDisplaySessionByManualPinWindowTitleAndWorkspace()
    {
        var now = DateTimeOffset.Parse("2026-11-22T12:00:00Z");

        WriteTranscript("antigravity", "conv-alpha",
        [
            new { step_index = 0, source = "USER_EXPLICIT", type = "USER_INPUT", status = "DONE", created_at = "2026-11-22T10:00:00Z", content = "<USER_REQUEST>\nRefactor crawler queue worker\n</USER_REQUEST>" },
            new { step_index = 1, source = "MODEL", type = "PLANNER_RESPONSE", status = "DONE", created_at = "2026-11-22T10:01:00Z", model = "gemini-4-neon-high", input_tokens = 120_000, cache_read_tokens = 0, output_tokens = 500, tool_calls = new[] { new { name = "read_file", args = new { Path = @"D:\Projects\NeoVNDB\src\Crawler.cs" } } } },
        ]);

        WriteTranscript("antigravity", "conv-beta",
        [
            new { step_index = 0, source = "USER_EXPLICIT", type = "USER_INPUT", status = "DONE", created_at = "2026-11-22T11:30:00Z", content = "<USER_REQUEST>\nRedesign UsageOrb floating panel\n</USER_REQUEST>" },
            new { step_index = 1, source = "MODEL", type = "PLANNER_RESPONSE", status = "DONE", created_at = "2026-11-22T11:31:00Z", model = "gemini-4-neon-high", input_tokens = 250_000, cache_read_tokens = 0, output_tokens = 500, tool_calls = new[] { new { name = "read_file", args = new { Path = @"D:\Program\Code\tools\AntigravityTools\UsageOrb\README.md" } } } },
        ]);

        // Ensure conv-beta has a newer mtime so it is the default LatestActive session
        var betaPath = Path.Combine(_tmpDir, "antigravity", "brain", "conv-beta", ".system_generated", "logs", "transcript.jsonl");
        File.SetLastWriteTimeUtc(betaPath, now.UtcDateTime);
        var alphaPath = Path.Combine(_tmpDir, "antigravity", "brain", "conv-alpha", ".system_generated", "logs", "transcript.jsonl");
        File.SetLastWriteTimeUtc(alphaPath, now.AddMinutes(-30).UtcDateTime);

        var snap = AnalyticsEngine.Collect(new AppSettings(), now: now);

        // 1. Generic window title falls back to LatestActive (conv-beta)
        var rDefault = SessionResolver.Resolve(snap, pinnedConversationId: null, trackedWindowTitle: "Antigravity");
        Assert.Equal(SessionBindSource.LatestActive, rDefault.Source);
        Assert.Equal("conv-beta", rDefault.Session?.ConversationId);

        // 2. Window title matching chat title switches immediately to conv-alpha without new writes
        var rTitle = SessionResolver.Resolve(snap, pinnedConversationId: null, trackedWindowTitle: "Refactor crawler queue worker - Antigravity");
        Assert.Equal(SessionBindSource.WindowTitleMatch, rTitle.Source);
        Assert.Equal("conv-alpha", rTitle.Session?.ConversationId);

        // 3. Workspace folder in IDE window title switches immediately to conv-alpha
        var rWorkspace = SessionResolver.Resolve(snap, pinnedConversationId: null, trackedWindowTitle: "Crawler.cs - NeoVNDB - Antigravity");
        Assert.Equal(SessionBindSource.WorkspaceMatch, rWorkspace.Source);
        Assert.Equal("conv-alpha", rWorkspace.Session?.ConversationId);

        // 4. Explicit manual pin overrides everything (even if window title points elsewhere)
        var rPinned = SessionResolver.Resolve(snap, pinnedConversationId: "conv-beta", trackedWindowTitle: "Refactor crawler queue worker - Antigravity");
        Assert.Equal(SessionBindSource.ManualPin, rPinned.Source);
        Assert.Equal("conv-beta", rPinned.Session?.ConversationId);
    }
}
