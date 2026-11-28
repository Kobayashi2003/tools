using System.Diagnostics;
using System.Diagnostics.CodeAnalysis;
using System.IO;
using System.Net;

namespace UsageOrb.Platform;

internal static class AntigravityDesktop
{
    private static readonly Uri GoogleApi = new("https://cloudcode-pa.googleapis.com/");
    private static readonly int SessionId = ReadSessionId();
    private static readonly TimeSpan StartupTimeout = TimeSpan.FromSeconds(8);
    private static readonly TimeSpan ShutdownTimeout = TimeSpan.FromSeconds(15);
    private static readonly string[] LocalProxyBypass =
        ["localhost", "127.0.0.1", "127.0.0.0/8", "::1", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"];

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

    private static string? FindExecutable() => new[]
    {
        Environment.GetEnvironmentVariable("USAGEORB_ANTIGRAVITY_EXE"),
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "antigravity", "Antigravity.exe"),
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "antigravity", "Antigravity.exe"),
    }.FirstOrDefault(File.Exists);

    public static bool IsWindowOpen()
    {
        var executable = FindExecutable();
        using var process = executable is null
            ? FindWindowProcess("Antigravity")
            : FindWindowProcess(Path.GetFileNameWithoutExtension(executable), Path.GetFullPath(executable));
        return process is not null;
    }

    public static Task<(bool Success, string Message)> StartAsync(string? proxyOverride, bool restart)
    {
        var executable = FindExecutable();
        if (executable is null)
            return Task.FromResult((false, "Antigravity was not found. Set USAGEORB_ANTIGRAVITY_EXE to its executable path."));

        return StartAsync(executable, proxyOverride ?? ResolveProxy(), restart);
    }

    internal static bool TryParseProxy(string? value, [NotNullWhen(true)] out Uri? proxy)
    {
        return Uri.TryCreate(value, UriKind.Absolute, out proxy) &&
            proxy.Scheme is "http" or "https" && proxy.Host.Length > 0 &&
            proxy.AbsolutePath == "/" && proxy.Query.Length == 0 && proxy.Fragment.Length == 0;
    }

    internal static async Task<(bool Success, string Message)> StartAsync(string executable, string? proxy, bool restart)
    {
        if (proxy is not null && proxy != "none" && !TryParseProxy(proxy, out _))
            return (false, "Enter an HTTP or HTTPS proxy URL with a host and port.");

        var path = Path.GetFullPath(executable);
        var processName = Path.GetFileNameWithoutExtension(path);
        using var current = FindWindowProcess(processName, path);
        if (current is not null && !current.HasExited)
        {
            if (!restart) return (false, "Antigravity is already open. Use Restart to apply the selected proxy.");
            if (!current.CloseMainWindow() && !current.HasExited)
                return (false, "Antigravity could not close. Check its window and try again.");

            using var timeout = new CancellationTokenSource(ShutdownTimeout);
            try
            {
                await current.WaitForExitAsync(timeout.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return (false, "Antigravity is still closing. Finish any prompt, then try again.");
            }
        }

        using var remaining = FindWindowProcess(processName, path);
        if (remaining is not null)
            return (false, "Another Antigravity window is still open. Close it before starting with new proxy settings.");

        using var started = Process.Start(BuildLaunchInfo(path, proxy));
        if (started is null) return (false, "Antigravity could not be started.");
        var startup = Stopwatch.StartNew();
        while (startup.Elapsed < StartupTimeout)
        {
            started.Refresh();
            if (started.HasExited)
                return (false, "The new process exited before opening a window. Check for a background Antigravity instance and try again.");
            if (started.MainWindowHandle != IntPtr.Zero)
                return (true, proxy is null or "none" ? "Antigravity opened." : "Antigravity opened with the selected proxy settings.");
            await Task.Delay(200).ConfigureAwait(false);
        }

        return (true, "Antigravity is starting. Its window has not opened yet.");
    }

    private static Process? FindWindowProcess(string processName, string? executable = null)
    {
        var processes = Process.GetProcessesByName(processName);
        Process? selected = null;
        try
        {
            foreach (var process in processes)
            {
                try
                {
                    if (process.SessionId != SessionId || process.HasExited || process.MainWindowHandle == IntPtr.Zero)
                        continue;
                    if (executable is not null &&
                        !string.Equals(process.MainModule?.FileName, executable, StringComparison.OrdinalIgnoreCase))
                        continue;
                    selected = process;
                    break;
                }
                catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception)
                {
                    // A window can disappear while enumerating processes.
                }
            }
            return selected;
        }
        finally
        {
            foreach (var process in processes)
            {
                if (process != selected) process.Dispose();
            }
        }
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
            var bypass = (noProxy ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Concat(LocalProxyBypass).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
            start.Environment["NO_PROXY"] = string.Join(',', bypass);
            // Chromium accepts an endpoint, while native HTTP clients can use credentials from the environment.
            if (TryParseProxy(proxy, out var uri) && uri.UserInfo.Length == 0)
            {
                start.ArgumentList.Add($"--proxy-server={uri.GetLeftPart(UriPartial.Authority)}");
                start.ArgumentList.Add($"--proxy-bypass-list={string.Join(';', bypass)}");
            }
        }
        return start;
    }
}
