using UsageOrb.Core;

namespace UsageOrb;

public static class Program
{
    public const string SingleInstanceMutexName = "Local\\AntigravityUsageOrb_SingleInstance_v1";
    public const string WakeEventName = "Local\\AntigravityUsageOrb_WakeConsole_v1";

    [STAThread]
    public static int Main(string[] args)
    {
        // Fast headless CLI bridge mode for Antigravity CLI `/statusline`
        if (args.Any(a => string.Equals(a, "--statusline", StringComparison.OrdinalIgnoreCase)))
        {
            return StatusLineRunner.RunFromStdio();
        }

        bool openConsole = args.Any(a => string.Equals(a, "--console", StringComparison.OrdinalIgnoreCase));

        using var mutex = new Mutex(initiallyOwned: true, SingleInstanceMutexName, out bool createdNew);
        if (!createdNew)
        {
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

        var app = new App(openConsoleOnStartup: openConsole);
        app.InitializeComponent();
        return app.Run();
    }
}
