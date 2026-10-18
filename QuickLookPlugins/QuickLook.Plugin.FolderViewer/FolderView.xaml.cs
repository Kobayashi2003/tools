using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Threading;
using QuickLook.Common.Helpers;
using QuickLook.Common.Plugin;

namespace QuickLook.Plugin.FolderViewer;

internal partial class FolderView : UserControl, IDisposable
{
    private readonly string _root;
    private readonly ContextObject _context;
    private readonly FolderScanner _scanner;
    private readonly FolderTree _tree;
    private readonly CancellationTokenSource _cancellation = new();
    private readonly DispatcherTimer _timer;
    private readonly Dictionary<GridViewColumnHeader, Column> _headers;
    private Task? _scan;
    private bool _disposed;

    public FolderView(string root, ContextObject context)
    {
        InitializeComponent();

        _root = root;
        _context = context;
        _scanner = new FolderScanner(root);
        _tree = new FolderTree(root, _scanner);
        _timer = new DispatcherTimer(DispatcherPriority.Background, Dispatcher) { Interval = TimeSpan.FromMilliseconds(250) };
        _timer.Tick += (_, _) => OnTick();

        _headers = new Dictionary<GridViewColumnHeader, Column>
        {
            [NameHeader] = new(SortKey.Name, Strings.Get("Column_Name")),
            [SizeHeader] = new(SortKey.Size, Strings.Get("Column_Size")),
            [TypeHeader] = new(SortKey.Type, Strings.Get("Column_Type")),
            [ModifiedHeader] = new(SortKey.Modified, Strings.Get("Column_Modified")),
        };
        UpdateHeaders();
        OpenItem.Header = Strings.Get("Menu_Open");
        RevealItem.Header = Strings.Get("Menu_Reveal");
        CopyPathItem.Header = Strings.Get("Menu_CopyPath");

        FolderName.Text = PathUtil.DisplayName(root);
        FolderPath.Text = root;
        FolderIcon.Source = ShellInfo.GetLargeIcon(root);
        List.ItemsSource = _tree.Rows;

        // Listing a large or remote folder can take a while; QuickLook shows its spinner meanwhile.
        _context.IsBusy = true;
        Task.Run(_tree.LoadRoot).ContinueWith(task => Dispatcher.BeginInvoke(new Action(() => OnRootLoaded(task))));
    }

    public void Dispose()
    {
        if (_disposed)
            return;

        _disposed = true;
        _timer.Stop();
        _cancellation.Cancel();
        _cancellation.Dispose();
    }

    private void OnRootLoaded(Task load)
    {
        if (_disposed)
            return;

        _context.IsBusy = false;
        if (load.IsFaulted)
        {
            ShowMessage(string.Format(Strings.Get("Error_CannotOpen"), load.Exception?.GetBaseException().Message));
            StatusBar.Visibility = Visibility.Collapsed;
            return;
        }

        _tree.ShowRoot();
        if (_tree.Root.LoadError is { } error)
            ShowMessage(string.Format(Strings.Get("Error_CannotOpen"), error));
        else if (_tree.Rows.Count == 0)
            ShowMessage(Strings.Get("Empty"));

        var token = _cancellation.Token;
        _scan = Task.Run(() => _scanner.Run(token), token);
        _timer.Start();
        OnTick();
    }

    private void OnTick()
    {
        _tree.RefreshSizes();

        var done = _scanner.IsCompleted || _scan is { IsCompleted: true };
        var partial = done && _scanner.TryGetSize(_root, out var rootSize) && rootSize.IsPartial;
        TotalSize.Text = (partial ? "≥ " : string.Empty) + Format.Size(_scanner.ByteCount);
        TotalCount.Text = string.Format(Strings.Get("Summary"), Format.Count(_scanner.FileCount), Format.Count(_scanner.FolderCount));

        if (!done)
        {
            StatusText.Text = Strings.Get("Status_Scanning");
            return;
        }

        _timer.Stop();
        ScanProgress.Visibility = Visibility.Collapsed;
        if (_scan is { IsFaulted: true })
        {
            ProcessHelper.WriteLog(_scan.Exception!.ToString());
            StatusText.Text = Strings.Get("Status_Failed");
        }
        else if (_scanner.InaccessibleCount > 0)
        {
            StatusText.Text = string.Format(Strings.Get("Status_Inaccessible"), Format.Count(_scanner.InaccessibleCount));
        }
        else
        {
            StatusBar.Visibility = Visibility.Collapsed;
        }

        if (_tree.SortKey == SortKey.Size)
            KeepSelection(_tree.Resort);
    }

    private void ShowMessage(string message)
    {
        EmptyText.Text = message;
        EmptyText.Visibility = Visibility.Visible;
    }

    private void UpdateHeaders()
    {
        foreach (var pair in _headers)
        {
            var content = new StackPanel { Orientation = Orientation.Horizontal };
            content.Children.Add(new TextBlock { Text = pair.Value.Title });
            if (pair.Value.Key == _tree.SortKey)
            {
                content.Children.Add(new TextBlock
                {
                    Text = _tree.SortDescending ? "" : "",
                    FontFamily = (FontFamily)FindResource("GlyphFont"),
                    FontSize = 9,
                    Margin = new Thickness(6, 0, 0, 0),
                    VerticalAlignment = VerticalAlignment.Center,
                });
            }

            pair.Key.Content = content;
        }
    }

    private void KeepSelection(Action change)
    {
        var selected = List.SelectedItem;
        change();
        if (selected is not null)
        {
            List.SelectedItem = selected;
            List.ScrollIntoView(selected);
        }
    }

    private void OnHeaderClick(object sender, RoutedEventArgs e)
    {
        if (e.OriginalSource is not GridViewColumnHeader header || !_headers.TryGetValue(header, out var column))
            return;

        KeepSelection(() => _tree.SortBy(column.Key));
        UpdateHeaders();
    }

    private void OnListSizeChanged(object sender, SizeChangedEventArgs e)
    {
        var others = SizeColumn.ActualWidth + TypeColumn.ActualWidth + ModifiedColumn.ActualWidth;
        NameColumn.Width = Math.Max(200, List.ActualWidth - others - SystemParameters.VerticalScrollBarWidth - 12);
    }

    private void OnExpanderMouseDown(object sender, MouseButtonEventArgs e)
    {
        if ((sender as FrameworkElement)?.DataContext is FileNode node)
        {
            _tree.Toggle(node);
            e.Handled = true;
        }
    }

    private void OnListDoubleClick(object sender, MouseButtonEventArgs e)
    {
        // Each click on the chevron already toggled the folder.
        if (e.OriginalSource is FrameworkElement { Tag: "Expander" })
            return;
        if (ItemsControl.ContainerFromElement(List, (DependencyObject)e.OriginalSource) is not ListViewItem { Content: FileNode node })
            return;

        if (node.CanExpand)
            _tree.Toggle(node);
        else
            Open(node.FullPath);
        e.Handled = true;
    }

    private void OnListKeyDown(object sender, KeyEventArgs e)
    {
        if (List.SelectedItem is not FileNode node)
            return;

        switch (e.Key)
        {
            case Key.Right when node.CanExpand && !node.IsExpanded:
                _tree.Expand(node);
                break;
            case Key.Left when node.IsExpanded:
                _tree.Collapse(node);
                break;
            case Key.Left when node.Parent is { Depth: >= 0 } parent:
                List.SelectedItem = parent;
                List.ScrollIntoView(parent);
                break;
            default:
                return;
        }

        e.Handled = true;
    }

    private void OnContextMenuOpening(object sender, ContextMenuEventArgs e)
    {
        if (List.SelectedItem is null)
            e.Handled = true;
    }

    private void OnOpenClick(object sender, RoutedEventArgs e)
    {
        if (List.SelectedItem is FileNode node)
            Open(node.FullPath);
    }

    private void OnRevealClick(object sender, RoutedEventArgs e)
    {
        if (List.SelectedItem is FileNode node)
            Start("explorer.exe", $"/select,\"{node.FullPath}\"");
    }

    private void OnCopyPathClick(object sender, RoutedEventArgs e)
    {
        if (List.SelectedItem is not FileNode node)
            return;

        try
        {
            Clipboard.SetText(node.FullPath);
        }
        catch (ExternalException ex)
        {
            // Another process holds the clipboard open.
            ProcessHelper.WriteLog(ex.ToString());
        }
    }

    private static void Open(string path) => Start(path, null);

    private static void Start(string fileName, string? arguments)
    {
        try
        {
            using var process = Process.Start(new ProcessStartInfo(fileName, arguments ?? string.Empty) { UseShellExecute = true });
        }
        catch (Exception ex) when (ex is Win32Exception or InvalidOperationException)
        {
            ProcessHelper.WriteLog(ex.ToString());
        }
    }

    private sealed class Column
    {
        public Column(SortKey key, string title)
        {
            Key = key;
            Title = title;
        }

        public SortKey Key { get; }

        public string Title { get; }
    }
}
