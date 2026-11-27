using Microsoft.Win32;

namespace UsageOrb.Platform;

public static class StartupManager
{
    private const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ValueName = "AntigravityUsageOrb";
    internal const string WatchArgument = "--watch-antigravity";
    internal const string BackgroundArgument = "--background";

    public static bool IsEnabled()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath, writable: false);
            return key?.GetValue(ValueName) is string s && !string.IsNullOrWhiteSpace(s) &&
                !s.EndsWith(" " + WatchArgument, StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }

    public static void SetEnabled(bool startWithWindows, bool followAntigravity)
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath, writable: true);
            if (key is null) return;

            if (startWithWindows || followAntigravity)
            {
                var exePath = Environment.ProcessPath;
                if (!string.IsNullOrWhiteSpace(exePath))
                {
                    var argument = startWithWindows ? BackgroundArgument : WatchArgument;
                    key.SetValue(ValueName, $"\"{exePath}\" {argument}");
                }
            }
            else
            {
                key.DeleteValue(ValueName, throwOnMissingValue: false);
            }
        }
        catch
        {
            // Ignore registry permission errors gracefully
        }
    }
}
