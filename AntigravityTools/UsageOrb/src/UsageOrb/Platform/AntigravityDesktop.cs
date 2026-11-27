using System.Diagnostics;
using System.IO;
using System.Net;

namespace UsageOrb.Platform;

internal static class AntigravityDesktop
{
    private static readonly Uri GoogleApi = new("https://cloudcode-pa.googleapis.com/");
    private static readonly int SessionId = ReadSessionId();

    public static bool IsRunning()
    {
        var processes = Process.GetProcessesByName("Antigravity");
        try
        {
            foreach (var process in processes)
            {
                try
                {
                    if (process.SessionId == SessionId && !process.HasExited) return true;
                }
                catch (InvalidOperationException)
                {
                    // Antigravity exited between the process snapshot and the check.
                }
            }
            return false;
        }
        finally
        {
            foreach (var process in processes) process.Dispose();
        }
    }

    private static int ReadSessionId()
    {
        using var current = Process.GetCurrentProcess();
        return current.SessionId;
    }

    public static string Launch()
    {
        if (IsRunning()) return "Antigravity is already running. Proxy changes apply on its next launch.";
        var executable = new[]
        {
            Environment.GetEnvironmentVariable("USAGEORB_ANTIGRAVITY_EXE"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "antigravity", "Antigravity.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "antigravity", "Antigravity.exe"),
        }.FirstOrDefault(File.Exists);
        if (executable is null) return "Antigravity was not found. Set USAGEORB_ANTIGRAVITY_EXE to its executable path.";

        var proxy = ResolveProxy();
        if (proxy is not null && proxy != "none" &&
            (!Uri.TryCreate(proxy, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https") || uri.Host.Length == 0))
        {
            return "The proxy must be an HTTP or HTTPS URL.";
        }

        using var process = Process.Start(BuildLaunchInfo(executable, proxy));
        if (process is null) return "Antigravity could not be started.";
        return proxy is not null && proxy != "none" ? "Started Antigravity with a proxy." : "Started Antigravity.";
    }

    private static string? ResolveProxy()
    {
        var custom = Environment.GetEnvironmentVariable("USAGEORB_ANTIGRAVITY_PROXY")?.Trim();
        if (!string.IsNullOrEmpty(custom)) return custom.Equals("none", StringComparison.OrdinalIgnoreCase) ? "none" : custom;
        foreach (var name in new[] { "HTTPS_PROXY", "HTTP_PROXY" })
        {
            var value = Environment.GetEnvironmentVariable(name)?.Trim();
            if (!string.IsNullOrEmpty(value)) return value;
        }

        var systemProxy = WebRequest.GetSystemWebProxy().GetProxy(GoogleApi);
        return systemProxy is null || systemProxy == GoogleApi ? null : systemProxy.AbsoluteUri;
    }

    internal static ProcessStartInfo BuildLaunchInfo(string executable, string? proxy)
    {
        var start = new ProcessStartInfo(executable)
        {
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(executable)!,
        };
        if (proxy == "none")
        {
            foreach (var name in new[] { "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY" }) start.Environment.Remove(name);
            start.ArgumentList.Add("--no-proxy-server");
        }
        else if (proxy is not null)
        {
            start.Environment["HTTP_PROXY"] = proxy;
            start.Environment["HTTPS_PROXY"] = proxy;
            start.Environment.TryGetValue("NO_PROXY", out var noProxy);
            start.Environment["NO_PROXY"] = string.Join(',', (noProxy ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Concat(["localhost", "127.0.0.1", "::1"]).Distinct(StringComparer.OrdinalIgnoreCase));
        }
        return start;
    }
}
