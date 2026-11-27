using UsageOrb.Platform;

namespace UsageOrb;

public static class Program
{
    public const string SingleInstanceMutexName = "Local\\AntigravityUsageOrb_SingleInstance_v1";
    public const string WakeEventName = "Local\\AntigravityUsageOrb_WakeConsole_v1";

    [STAThread]
    public static int Main(string[] args)
    {
        bool openConsole = false;
        bool background = false;
        foreach (var arg in args)
        {
            switch (arg.ToLowerInvariant())
            {
                case "--console":
                    openConsole = true;
                    break;
                case StartupManager.WatchArgument:
                case StartupManager.BackgroundArgument:
                    background = true;
                    break;
                default:
                    return 2;
            }
        }

        using var mutex = new Mutex(initiallyOwned: true, SingleInstanceMutexName, out bool createdNew);
        if (!createdNew)
        {
            if (background && !openConsole) return 0;
            // Signal the running instance to open its management console
            try
            {
                using var wake = EventWaitHandle.OpenExisting(WakeEventName);
                wake.Set();
            }
            catch
            {
                // Ignore if primary instance is still initializing
            }

            return 0;
        }

        var app = new App(openConsoleOnStartup: openConsole, backgroundStartup: background);
        app.InitializeComponent();
        return app.Run();
    }
}
