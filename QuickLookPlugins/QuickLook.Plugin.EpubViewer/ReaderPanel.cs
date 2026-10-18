using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using QuickLook.Common.Helpers;
using QuickLook.Common.Plugin;

namespace QuickLook.Plugin.EpubViewer;

/// <summary>
/// Hosts the bundled web reader (web/dist) in WebView2. Every request to <see cref="Origin"/> is
/// answered from disk here: the reader's files, and the previewed book at <c>/book</c>, so the
/// book is streamed straight from its file and the page needs no file:// access.
/// </summary>
internal sealed class ReaderPanel : UserControl, IDisposable
{
    // A fixed origin keeps the reader's saved positions (localStorage) across previews.
    private const string Origin = "https://epubviewer.quicklook/";

    private readonly string _bookPath;
    private readonly ContextObject _context;
    private readonly string _webRoot;
    private WebView2? _webView;

    public ReaderPanel(string bookPath, ContextObject context)
    {
        _bookPath = bookPath;
        _context = context;
        _webRoot = Path.Combine(Path.GetDirectoryName(typeof(ReaderPanel).Assembly.Location) ?? string.Empty, "web");

        if (!IsWebView2Available())
        {
            ShowWebView2Missing();
            return;
        }

        var dark = OSThemeHelper.AppsUseDarkTheme();
        _webView = new WebView2
        {
            // The same data folder and options as QuickLook's HtmlViewer, so both share one browser.
            CreationProperties = new CoreWebView2CreationProperties
            {
                UserDataFolder = Path.Combine(SettingHelper.LocalDataPath, @"WebView2_Data\"),
            },
            // Avoids a white flash before the reader paints.
            DefaultBackgroundColor = dark ? System.Drawing.Color.FromArgb(255, 32, 32, 32) : System.Drawing.Color.White,
        };
        _webView.CoreWebView2InitializationCompleted += (_, e) => OnInitialized(e, dark);
        Content = _webView;
        // Failures arrive through CoreWebView2InitializationCompleted; the task faults too (E_ABORT
        // when the preview is closed while starting), so observe it to keep it out of QuickLook's log.
        _webView.EnsureCoreWebView2Async()
            .ContinueWith(task => _ = task.Exception, TaskContinuationOptions.OnlyOnFaulted);
    }

    public void Dispose()
    {
        _webView?.Dispose();
        _webView = null;
    }

    private static bool IsWebView2Available()
    {
        try
        {
            return !string.IsNullOrEmpty(CoreWebView2Environment.GetAvailableBrowserVersionString());
        }
        catch (WebView2RuntimeNotFoundException)
        {
            return false;
        }
    }

    private void OnInitialized(CoreWebView2InitializationCompletedEventArgs e, bool dark)
    {
        if (_webView is null)
            return;
        if (!e.IsSuccess)
        {
            ShowMessage(string.Format(Strings.Get("Load_Failed"), e.InitializationException?.Message));
            return;
        }

        var core = _webView.CoreWebView2;
        var settings = core.Settings;
        // The reader has its own menus, zoom and shortcuts (Ctrl+F searches the book).
        settings.AreDefaultContextMenusEnabled = false;
        settings.AreBrowserAcceleratorKeysEnabled = false;
        settings.IsZoomControlEnabled = false;
        settings.IsStatusBarEnabled = false;
        settings.AreDevToolsEnabled = false;

        core.AddWebResourceRequestedFilter(Origin + "*", CoreWebView2WebResourceContext.All);
        core.WebResourceRequested += OnResourceRequested;
        core.NavigationStarting += OnNavigationStarting;
        core.NewWindowRequested += OnNewWindowRequested;
        core.ContainsFullScreenElementChanged += OnFullScreenChanged;
        core.NavigationCompleted += (_, _) => _context.IsBusy = false;

        var query = "?name=" + Uri.EscapeDataString(Path.GetFileName(_bookPath)) + (dark ? "&theme=dark" : string.Empty);
        core.Navigate(Origin + "index.html" + query);
    }

    private void OnResourceRequested(object? sender, CoreWebView2WebResourceRequestedEventArgs e)
    {
        var environment = _webView?.CoreWebView2?.Environment;
        if (environment is null)
            return;

        var path = Uri.UnescapeDataString(new Uri(e.Request.Uri).AbsolutePath).TrimStart('/');
        var file = path == "book" ? _bookPath : ResolveAsset(path);
        if (file is null || !File.Exists(ExtendedPath(file)))
        {
            e.Response = environment.CreateWebResourceResponse(null, 404, "Not Found", string.Empty);
            return;
        }

        // Shared access so the file can still be renamed or deleted in Explorer while previewed.
        var stream = new FileStream(ExtendedPath(file), FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        // no-store: /book is the same URL for every book, so nothing may be served from cache.
        e.Response = environment.CreateWebResourceResponse(
            stream,
            200,
            "OK",
            "Content-Type: " + MimeType(file) + "\r\nCache-Control: no-store");
    }

    /// <summary>Maps a request path into web/, refusing anything that escapes it.</summary>
    private string? ResolveAsset(string path)
    {
        if (path.Length == 0)
            path = "index.html";

        var full = Path.GetFullPath(Path.Combine(_webRoot, path.Replace('/', Path.DirectorySeparatorChar)));
        return full.StartsWith(_webRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) ? full : null;
    }

    private void OnNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        if (e.Uri.StartsWith(Origin, StringComparison.OrdinalIgnoreCase))
            return;

        e.Cancel = true;
        OpenExternally(e.Uri);
    }

    private void OnNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        e.Handled = true;
        OpenExternally(e.Uri);
    }

    /// <summary>The reader's fullscreen button maximizes the QuickLook window instead.</summary>
    private void OnFullScreenChanged(object? sender, object e)
    {
        var window = Window.GetWindow(this);
        if (window is not null && _webView?.CoreWebView2 is { } core)
            window.WindowState = core.ContainsFullScreenElement ? WindowState.Maximized : WindowState.Normal;
    }

    /// <summary>The reader has already asked the user to confirm the link.</summary>
    private static void OpenExternally(string uri)
    {
        if (!Uri.TryCreate(uri, UriKind.Absolute, out var parsed)
            || (parsed.Scheme != Uri.UriSchemeHttp && parsed.Scheme != Uri.UriSchemeHttps && parsed.Scheme != Uri.UriSchemeMailto))
            return;

        try
        {
            using var process = Process.Start(new ProcessStartInfo(parsed.AbsoluteUri) { UseShellExecute = true });
        }
        catch (Win32Exception ex)
        {
            ProcessHelper.WriteLog(ex.ToString());
        }
    }

    private void ShowWebView2Missing()
    {
        var download = new Button
        {
            Content = Strings.Get("WebView2_Download"),
            Margin = new Thickness(0, 12, 0, 0),
            Padding = new Thickness(20, 6, 20, 6),
            HorizontalAlignment = HorizontalAlignment.Center,
        };
        download.Click += (_, _) => OpenExternally("https://go.microsoft.com/fwlink/p/?LinkId=2124703");

        var panel = new StackPanel { HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
        panel.Children.Add(CreateText(Strings.Get("WebView2_Missing")));
        panel.Children.Add(download);
        Content = panel;
        _context.IsBusy = false;
    }

    private void ShowMessage(string message)
    {
        Content = CreateText(message);
        _context.IsBusy = false;
    }

    private TextBlock CreateText(string text)
    {
        var block = new TextBlock
        {
            Text = text,
            Margin = new Thickness(24),
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center,
            TextWrapping = TextWrapping.Wrap,
        };
        block.SetResourceReference(TextBlock.ForegroundProperty, "WindowTextForeground");
        return block;
    }

    private static string ExtendedPath(string path) =>
        path.Length < 260 || path.StartsWith(@"\\?\", StringComparison.Ordinal) ? path
        : path.StartsWith(@"\\", StringComparison.Ordinal) ? @"\\?\UNC\" + path.Substring(2)
        : @"\\?\" + path;

    private static string MimeType(string file) => Path.GetExtension(file).ToLowerInvariant() switch
    {
        ".html" => "text/html; charset=utf-8",
        ".js" => "text/javascript; charset=utf-8",
        ".css" => "text/css; charset=utf-8",
        ".svg" => "image/svg+xml",
        ".png" => "image/png",
        ".woff2" => "font/woff2",
        ".json" => "application/json",
        _ => "application/octet-stream",
    };
}
