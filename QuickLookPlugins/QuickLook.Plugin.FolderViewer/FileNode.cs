using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Globalization;
using System.IO;

namespace QuickLook.Plugin.FolderViewer;

/// <summary>One row of the tree; children are listed only when the node is first expanded.</summary>
internal sealed class FileNode : INotifyPropertyChanged
{
    public const double IndentWidth = 16;

    private List<FileNode>? _children;
    private bool _isExpanded;
    private long? _length;
    private bool _isSizePartial;
    private bool _isSizePending;
    private string? _typeName;

    /// <summary>Creates the invisible root whose children are the top-level rows.</summary>
    public FileNode(string fullPath)
    {
        Name = fullPath;
        FullPath = fullPath;
        IsDirectory = true;
        Depth = -1;
    }

    public FileNode(FileNode parent, FsEntry entry)
    {
        Parent = parent;
        Name = entry.Name;
        FullPath = Path.Combine(parent.FullPath, entry.Name);
        IsDirectory = entry.IsDirectory;
        IsReparsePoint = entry.IsReparsePoint;
        IsHidden = (entry.Attributes & FileAttributes.Hidden) != 0;
        Modified = entry.LastWriteTimeUtc == DateTime.MinValue ? DateTime.MinValue : entry.LastWriteTimeUtc.ToLocalTime();
        Depth = parent.Depth + 1;
        if (!IsDirectory)
            _length = entry.Length;
    }

    public event PropertyChangedEventHandler? PropertyChanged;

    public string Name { get; }

    public string FullPath { get; }

    public FileNode? Parent { get; }

    public bool IsDirectory { get; }

    public bool IsReparsePoint { get; }

    public bool IsHidden { get; }

    public DateTime Modified { get; }

    public int Depth { get; }

    public double Indent => Depth * IndentWidth;

    /// <summary>Null until the folder has been listed.</summary>
    public List<FileNode>? Children
    {
        get => _children;
        set
        {
            _children = value;
            OnPropertyChanged(nameof(CanExpand));
        }
    }

    /// <summary>Why the folder could not be listed, if it could not.</summary>
    public string? LoadError { get; set; }

    public bool CanExpand => IsDirectory && !IsReparsePoint && (_children is null || _children.Count > 0);

    public bool IsExpanded
    {
        get => _isExpanded;
        set
        {
            if (_isExpanded == value)
                return;
            _isExpanded = value;
            OnPropertyChanged(nameof(IsExpanded));
        }
    }

    /// <summary>File length, or a folder's total once the scanner has reached it.</summary>
    public long? Length => _length;

    public bool IsSizePending
    {
        get => _isSizePending;
        set
        {
            _isSizePending = value;
            OnPropertyChanged(nameof(SizeText));
        }
    }

    public string SizeText => _length is { } length
        ? (_isSizePartial ? "≥ " : string.Empty) + Format.Size(length)
        : _isSizePending ? "…" : string.Empty;

    public string ModifiedText => Modified == DateTime.MinValue
        ? string.Empty
        : Modified.ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture);

    public string TypeName => _typeName ??= ShellInfo.GetTypeName(Name, IsDirectory);

    public string ToolTip => LoadError is null ? FullPath : FullPath + Environment.NewLine + LoadError;

    public void SetFolderSize(FolderSize size)
    {
        _length = size.Bytes;
        _isSizePartial = size.IsPartial;
        _isSizePending = false;
        OnPropertyChanged(nameof(Length));
        OnPropertyChanged(nameof(SizeText));
    }

    private void OnPropertyChanged(string name) => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
}
