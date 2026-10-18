using System.IO;
using System.Windows;
using QuickLook.Common.Plugin;

namespace QuickLook.Plugin.FolderViewer;

public sealed class Plugin : IViewer
{
    private FolderView? _view;

    // Above QuickLook's built-in info panel, the only other viewer that accepts folders.
    public int Priority => 0;

    public void Init()
    {
    }

    public bool CanHandle(string path) => Directory.Exists(path);

    public void Prepare(string path, ContextObject context)
    {
        context.PreferredSize = new Size(900, 560);
    }

    public void View(string path, ContextObject context)
    {
        var root = PathUtil.Normalize(path);
        _view = new FolderView(root, context);
        context.ViewerContent = _view;
        context.Title = PathUtil.DisplayName(root);
    }

    public void Cleanup()
    {
        _view?.Dispose();
        _view = null;
    }
}
