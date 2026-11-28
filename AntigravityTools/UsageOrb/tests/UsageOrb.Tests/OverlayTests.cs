using System.Runtime.ExceptionServices;
using System.Windows;
using UsageOrb.Platform;
using UsageOrb.UI;
using Xunit;

namespace UsageOrb.Tests;

public sealed class OverlayTests
{
    [Fact]
    public void ReopeningHoverCardAfterMovingOrbStartsAtTheNewPosition()
    {
        ExceptionDispatchInfo? error = null;
        var thread = new Thread(() =>
        {
            try
            {
                var orb = new Window { Left = 90, Top = 420, Width = 48, Height = 48 };
                var card = new HoverTooltipWindow();
                try
                {
                    card.ShowNear(orb);
                    double oldLeft = card.Left;
                    card.Hide();
                    orb.Left += 130;

                    double firstVisibleLeft = double.NaN;
                    card.IsVisibleChanged += (_, args) =>
                    {
                        if (args.NewValue is true) firstVisibleLeft = card.Left;
                    };
                    card.ShowNear(orb);
                    Assert.InRange(Math.Abs(card.Left - firstVisibleLeft), 0, 1);
                    Assert.InRange(Math.Abs(card.Left - oldLeft), 110, 150);
                }
                finally
                {
                    card.Close();
                    orb.Close();
                }
            }
            catch (Exception ex)
            {
                error = ExceptionDispatchInfo.Capture(ex);
            }
        }) { IsBackground = true };
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        Assert.True(thread.Join(TimeSpan.FromSeconds(10)));
        error?.Throw();
    }

    [Fact]
    public void AntigravityLauncherAppliesTheProxyOnlyToItsChildEnvironment()
    {
        string? previous = Environment.GetEnvironmentVariable("HTTP_PROXY");
        const string proxy = "http://127.0.0.1:3128";
        var launch = AntigravityDesktop.BuildLaunchInfo(@"C:\Example\Antigravity.exe", proxy);
        Assert.Equal(proxy, launch.Environment["HTTP_PROXY"]);
        Assert.Equal(proxy, launch.Environment["HTTPS_PROXY"]);
        Assert.Contains("127.0.0.0/8", launch.Environment["NO_PROXY"]!.Split(','));
        Assert.Contains("--proxy-server=http://127.0.0.1:3128", launch.ArgumentList);
        Assert.Contains(launch.ArgumentList, arg => arg.StartsWith("--proxy-bypass-list=") && arg.Contains("localhost"));
        Assert.Equal(previous, Environment.GetEnvironmentVariable("HTTP_PROXY"));
        Assert.False(launch.UseShellExecute);
    }

    [Fact]
    public void DirectAntigravityLaunchClearsInheritedProxyAndDisablesChromiumProxy()
    {
        var launch = AntigravityDesktop.BuildLaunchInfo(@"C:\Example\Antigravity.exe", "none");

        Assert.False(launch.Environment.ContainsKey("HTTP_PROXY"));
        Assert.False(launch.Environment.ContainsKey("HTTPS_PROXY"));
        Assert.False(launch.Environment.ContainsKey("ALL_PROXY"));
        Assert.Contains("--no-proxy-server", launch.ArgumentList);
    }
}
