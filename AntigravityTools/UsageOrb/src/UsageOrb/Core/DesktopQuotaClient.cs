using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using UsageOrb.Platform;

namespace UsageOrb.Core;

internal static class DesktopQuotaClient
{
    private const string Endpoint = "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary";
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true };

    internal sealed class Registration
    {
        public int Pid { get; init; }
        public int HttpsPort { get; init; }
        public string? CsrfToken { get; init; }
        public string? LsVersion { get; init; }
    }

    public static Registration? FindServer()
    {
        foreach (var root in AntigravityPaths.GetBrainRoots().Where(root => root.Surface == AntigravitySurface.App))
        {
            var directory = Path.Combine(Path.GetDirectoryName(root.BrainDir)!, "daemon");
            if (!Directory.Exists(directory)) continue;

            var files = new DirectoryInfo(directory).GetFiles("hub_*.json").OrderByDescending(f => f.LastWriteTimeUtc);
            foreach (var file in files)
            {
                try
                {
                    if (file.Length is <= 0 or > 4096) continue;
                    using var stream = file.Open(FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                    var server = JsonSerializer.Deserialize<Registration>(stream, JsonOptions);
                    if (server is { Pid: > 0, HttpsPort: > 0 and <= 65535, CsrfToken.Length: > 0 and <= 512 } &&
                        !server.CsrfToken.Any(char.IsControl) && IsDesktopServer(server.Pid)) return server;
                }
                catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
                {
                    // The registration can disappear while Antigravity restarts.
                }
            }
        }
        return null;
    }

    private static bool IsDesktopServer(int pid)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            if (!process.ProcessName.Equals("language_server", StringComparison.OrdinalIgnoreCase)) return false;
            var path = process.MainModule?.FileName;
            if (path is null || !path.EndsWith(@"\resources\bin\language_server.exe", StringComparison.OrdinalIgnoreCase)) return false;
            string appPath = Path.Combine(Path.GetFullPath(Path.Combine(path, "..", "..", "..")), "Antigravity.exe");
            var hosts = Process.GetProcessesByName("Antigravity");
            try
            {
                return hosts.Any(host => host.SessionId == process.SessionId &&
                    string.Equals(host.MainModule?.FileName, appPath, StringComparison.OrdinalIgnoreCase));
            }
            finally
            {
                foreach (var host in hosts) host.Dispose();
            }
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            return false;
        }
    }

    public static async Task<RawStatusLinePayload?> ReadAsync(Registration server, CancellationToken cancellationToken)
    {
        using var handler = new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            UseProxy = false,
            UseCookies = false,
            // The desktop server uses a self-signed certificate. Validate the socket owner before TLS.
            ConnectCallback = (_, token) => LoopbackConnection.ConnectAsync(server.Pid, server.HttpsPort, token),
            SslOptions = new() { RemoteCertificateValidationCallback = (_, cert, _, _) => cert is not null },
        };
        using var client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(15), MaxResponseContentBufferSize = 512 * 1024 };
        using var request = new HttpRequestMessage(HttpMethod.Post, $"https://127.0.0.1:{server.HttpsPort}{Endpoint}");
        request.Headers.Add("X-Codeium-Csrf-Token", server.CsrfToken!);
        request.Headers.Add("Connect-Protocol-Version", "1");
        var metadata = new { ideName = "antigravity", extensionName = "antigravity", locale = "en", ideVersion = server.LsVersion ?? "unknown" };
        request.Content = new StringContent(JsonSerializer.Serialize(new { metadata }), Encoding.UTF8, "application/json");
        using var response = await client.SendAsync(request, cancellationToken).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode) return null;
        using var stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
        using var json = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken).ConfigureAwait(false);
        return ParseSummary(json.RootElement);
    }

    internal static RawStatusLinePayload? ParseSummary(JsonElement root)
    {
        var summary = Property(root, "response");
        if (summary.ValueKind == JsonValueKind.Undefined) summary = root;
        var groups = Property(summary, "groups");
        if (groups.ValueKind != JsonValueKind.Array) return null;

        var quotas = new Dictionary<string, RawStatusLineQuotaBucket>(StringComparer.OrdinalIgnoreCase);
        foreach (var group in groups.EnumerateArray())
        {
            var buckets = Property(group, "buckets");
            if (buckets.ValueKind != JsonValueKind.Array) continue;
            var poolName = ReadText(group, "displayName");
            foreach (var bucket in buckets.EnumerateArray())
            {
                var id = ReadText(bucket, "bucketId");
                if (string.IsNullOrWhiteSpace(id)) continue;
                var remaining = Property(bucket, "remaining");
                var fraction = ReadNumber(bucket, "remainingFraction") ?? ReadNumber(remaining, "remainingFraction");
                var amount = ReadNumber(bucket, "remainingAmount") ?? ReadNumber(remaining, "remainingAmount");
                var label = ReadText(bucket, "displayName") ?? ModelCatalog.FormatQuotaBucketLabel(id);
                quotas.TryAdd(id, new RawStatusLineQuotaBucket
                {
                    RemainingFraction = fraction is >= 0 and <= 1 ? fraction : null,
                    RemainingAmount = amount is >= 0 ? amount : null,
                    ResetTime = ReadText(bucket, "resetTime") ?? ReadText(remaining, "resetTime"),
                    ResetInSeconds = ReadNumber(bucket, "resetInSeconds") ?? ReadNumber(remaining, "resetInSeconds"),
                    Disabled = Property(bucket, "disabled").ValueKind == JsonValueKind.True,
                    PoolName = poolName,
                    DisplayLabel = string.IsNullOrEmpty(poolName) ? label : $"{poolName} · {label}",
                    Window = ReadText(bucket, "window")?.ToLowerInvariant() switch
                    {
                        "5h" or "5-hour" => WindowKey.FiveHours,
                        "weekly" or "7d" => WindowKey.SevenDays,
                        _ => null,
                    },
                });
            }
        }

        return quotas.Count > 0 ? new RawStatusLinePayload { Quota = quotas } : null;
    }

    private static JsonElement Property(JsonElement node, string name) =>
        node.ValueKind == JsonValueKind.Object && node.TryGetProperty(name, out var value) ? value : default;

    private static string? ReadText(JsonElement node, string name) =>
        Property(node, name) is { ValueKind: JsonValueKind.String } value ? value.GetString() : null;

    private static double? ReadNumber(JsonElement node, string name) =>
        Property(node, name) is { ValueKind: JsonValueKind.Number } value && value.TryGetDouble(out var number) && double.IsFinite(number)
            ? number : null;
}
