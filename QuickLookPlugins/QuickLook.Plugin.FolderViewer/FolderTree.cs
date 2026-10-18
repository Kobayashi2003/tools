using System;
using System.Collections.Generic;
using System.ComponentModel;

namespace QuickLook.Plugin.FolderViewer;

internal enum SortKey
{
    Name,
    Size,
    Type,
    Modified,
}

/// <summary>
/// Keeps the expanded part of the tree flattened into <see cref="Rows"/>, so a virtualizing ListView
/// can show it with real columns however many entries a folder holds.
/// </summary>
internal sealed class FolderTree
{
    private readonly FolderScanner _scanner;
    private readonly List<FileNode> _pendingSizes = new();

    public FolderTree(string rootPath, FolderScanner scanner)
    {
        Root = new FileNode(rootPath);
        _scanner = scanner;
    }

    public FileNode Root { get; }

    public BulkObservableCollection<FileNode> Rows { get; } = new();

    public SortKey SortKey { get; private set; } = SortKey.Name;

    public bool SortDescending { get; private set; }

    private NodeComparer Comparer => new(SortKey, SortDescending);

    /// <summary>Lists the root; may run off the UI thread, before <see cref="ShowRoot"/> runs on it.</summary>
    public void LoadRoot() => EnsureChildren(Root);

    public void ShowRoot() => Rows.ReplaceAll(Root.Children ?? new List<FileNode>());

    public void Toggle(FileNode node)
    {
        if (node.IsExpanded)
            Collapse(node);
        else
            Expand(node);
    }

    public void Expand(FileNode node)
    {
        if (node.IsExpanded || !node.IsDirectory || node.IsReparsePoint)
            return;

        EnsureChildren(node);
        if (node.Children!.Count == 0)
            return;

        node.IsExpanded = true;
        var index = Rows.IndexOf(node);
        if (index < 0)
            return;

        var visible = new List<FileNode>();
        CollectVisible(node, visible);
        Rows.InsertRange(index + 1, visible);
    }

    public void Collapse(FileNode node)
    {
        if (!node.IsExpanded)
            return;

        node.IsExpanded = false;
        var index = Rows.IndexOf(node);
        if (index < 0)
            return;

        var end = index + 1;
        while (end < Rows.Count && Rows[end].Depth > node.Depth)
            end++;
        Rows.RemoveRange(index + 1, end - index - 1);
    }

    /// <summary>Sorts by <paramref name="key"/>, flipping the direction when it is already the key.</summary>
    public void SortBy(SortKey key)
    {
        SortDescending = key == SortKey ? !SortDescending : key is SortKey.Size or SortKey.Modified;
        SortKey = key;
        Resort();
    }

    public void Resort()
    {
        SortChildren(Root, Comparer);
        var visible = new List<FileNode>();
        CollectVisible(Root, visible);
        Rows.ReplaceAll(visible);
    }

    /// <summary>Copies finished folder sizes from the scanner into the rows waiting for them.</summary>
    public void RefreshSizes()
    {
        // Read before the lookups: once the scan is complete every size it will ever have is stored.
        var completed = _scanner.IsCompleted;
        for (var i = _pendingSizes.Count - 1; i >= 0; i--)
        {
            var node = _pendingSizes[i];
            if (_scanner.TryGetSize(node.FullPath, out var size))
                node.SetFolderSize(size);
            else if (completed)
                node.IsSizePending = false;
            else
                continue;

            _pendingSizes[i] = _pendingSizes[_pendingSizes.Count - 1];
            _pendingSizes.RemoveAt(_pendingSizes.Count - 1);
        }
    }

    private void EnsureChildren(FileNode node)
    {
        if (node.Children is not null)
            return;

        var entries = new List<FsEntry>();
        var error = DirectoryReader.Read(node.FullPath, entries);
        if (error != 0)
            node.LoadError = new Win32Exception(error).Message;

        var children = new List<FileNode>(entries.Count);
        foreach (var entry in entries)
        {
            var child = new FileNode(node, entry);
            if (child.IsDirectory && !child.IsReparsePoint)
                TrackSize(child);
            children.Add(child);
        }

        children.Sort(Comparer);
        node.Children = children;
    }

    private void TrackSize(FileNode node)
    {
        if (_scanner.TryGetSize(node.FullPath, out var size))
        {
            node.SetFolderSize(size);
        }
        else if (!_scanner.IsCompleted)
        {
            node.IsSizePending = true;
            _pendingSizes.Add(node);
        }
    }

    private static void SortChildren(FileNode node, NodeComparer comparer)
    {
        if (node.Children is null)
            return;

        node.Children.Sort(comparer);
        foreach (var child in node.Children)
            SortChildren(child, comparer);
    }

    private static void CollectVisible(FileNode node, List<FileNode> rows)
    {
        if (node.Children is null)
            return;

        foreach (var child in node.Children)
        {
            rows.Add(child);
            if (child.IsExpanded)
                CollectVisible(child, rows);
        }
    }
}

/// <summary>Folders first, then by the key; ties fall back to File Explorer's name order.</summary>
internal sealed class NodeComparer : IComparer<FileNode>
{
    private readonly SortKey _key;
    private readonly bool _descending;

    public NodeComparer(SortKey key, bool descending)
    {
        _key = key;
        _descending = descending;
    }

    public int Compare(FileNode? x, FileNode? y)
    {
        if (ReferenceEquals(x, y))
            return 0;
        if (x is null)
            return -1;
        if (y is null)
            return 1;
        if (x.IsDirectory != y.IsDirectory)
            return x.IsDirectory ? -1 : 1;

        var result = _key switch
        {
            SortKey.Size => Nullable.Compare(x.Length, y.Length),
            SortKey.Type => string.Compare(x.TypeName, y.TypeName, StringComparison.CurrentCultureIgnoreCase),
            SortKey.Modified => x.Modified.CompareTo(y.Modified),
            _ => NativeMethods.StrCmpLogicalW(x.Name, y.Name),
        };
        if (_descending)
            result = -result;
        if (result == 0 && _key != SortKey.Name)
            result = NativeMethods.StrCmpLogicalW(x.Name, y.Name);
        return result;
    }
}
