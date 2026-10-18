using System;
using System.IO;
using System.Linq;
using System.Windows;
using QuickLook.Common.Plugin;

namespace QuickLook.Plugin.EpubViewer;

public sealed class Plugin : IViewer
{
    // .mobi opens when it carries a KF8 part; the reader explains why an older one cannot.
    private static readonly string[] Extensions = { ".epub", ".azw3", ".mobi" };

    private ReaderPanel? _panel;

    public int Priority => 0;

    public void Init()
    {
    }

    public bool CanHandle(string path) =>
        !Directory.Exists(path)
        && Extensions.Any(extension => path.EndsWith(extension, StringComparison.OrdinalIgnoreCase));

    public void Prepare(string path, ContextObject context)
    {
        context.PreferredSize = new Size(1100, 780);
    }

    public void View(string path, ContextObject context)
    {
        _panel = new ReaderPanel(path, context);
        context.ViewerContent = _panel;
        context.Title = Path.GetFileName(path);
    }

    public void Cleanup()
    {
        _panel?.Dispose();
        _panel = null;
    }
}
