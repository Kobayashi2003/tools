using System.Windows;
using Microsoft.Win32;
using UsageOrb.Core;

namespace UsageOrb.Platform;

public sealed class ThemeService : IDisposable
{
    private const string PersonalizeKey = @"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize";
    private ThemePreference _preference = ThemePreference.System;
    private bool _isDark = true;
    private bool _disposed;

    public bool IsDark => _isDark;

    public event Action<bool>? ThemeChanged;

    public ThemeService()
    {
        SystemEvents.UserPreferenceChanged += OnSystemPreferenceChanged;
    }

    public void Apply(ThemePreference preference)
    {
        _preference = preference;
        bool targetDark = preference switch
        {
            ThemePreference.Dark => true,
            ThemePreference.Light => false,
            _ => DetectWindowsDarkMode(),
        };

        _isDark = targetDark;
        ApplyResourceDictionary(targetDark);
        ThemeChanged?.Invoke(targetDark);
    }

    private void OnSystemPreferenceChanged(object? sender, UserPreferenceChangedEventArgs e)
    {
        if (_preference != ThemePreference.System) return;
        var dispatcher = System.Windows.Application.Current?.Dispatcher;
        if (dispatcher is null) return;

        dispatcher.BeginInvoke(() =>
        {
            bool nextDark = DetectWindowsDarkMode();
            if (nextDark != _isDark)
            {
                _isDark = nextDark;
                ApplyResourceDictionary(nextDark);
                ThemeChanged?.Invoke(nextDark);
            }
        });
    }

    private static bool DetectWindowsDarkMode()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(PersonalizeKey);
            if (key?.GetValue("AppsUseLightTheme") is int val)
            {
                return val == 0;
            }
        }
        catch
        {
            // Default to dark theme when registry read is unavailable
        }

        return true;
    }

    private static void ApplyResourceDictionary(bool dark)
    {
        var app = System.Windows.Application.Current;
        if (app is null) return;

        var uri = new Uri(
            dark ? "pack://application:,,,/UI/Themes/DarkTheme.xaml" : "pack://application:,,,/UI/Themes/LightTheme.xaml",
            UriKind.Absolute);

        var dict = new ResourceDictionary { Source = uri };
        var merged = app.Resources.MergedDictionaries;

        for (int i = merged.Count - 1; i >= 0; i--)
        {
            var src = merged[i].Source?.OriginalString ?? "";
            if (src.Contains("DarkTheme.xaml", StringComparison.OrdinalIgnoreCase) ||
                src.Contains("LightTheme.xaml", StringComparison.OrdinalIgnoreCase))
            {
                merged.RemoveAt(i);
            }
        }

        merged.Insert(0, dict);
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        SystemEvents.UserPreferenceChanged -= OnSystemPreferenceChanged;
    }
}
