using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Threading;

namespace QuickLook.Plugin.FolderViewer;

internal readonly struct FolderSize
{
    public FolderSize(long bytes, bool isPartial)
    {
        Bytes = bytes;
        IsPartial = isPartial;
    }

    public long Bytes { get; }

    /// <summary>Some folder below could not be read, so <see cref="Bytes"/> is a lower bound.</summary>
    public bool IsPartial { get; }
}

/// <summary>
/// Walks a folder tree once, on whatever thread calls <see cref="Run"/>, totalling sizes bottom-up.
/// The counters and <see cref="TryGetSize"/> may be read from other threads while it runs.
/// </summary>
internal sealed class FolderScanner
{
    /// <summary>
    /// Sizes are kept only for folders this many levels below the root, which bounds memory when a
    /// whole drive is previewed; nobody expands a preview deeper than that.
    /// </summary>
    public const int DefaultDepthLimit = 8;

    private readonly string _root;
    private readonly int _depthLimit;
    private readonly ConcurrentDictionary<string, FolderSize> _sizes = new(StringComparer.OrdinalIgnoreCase);
    private long _files;
    private long _folders;
    private long _bytes;
    private long _inaccessible;
    private volatile bool _isCompleted;

    /// <param name="root">A full path, as produced by <see cref="PathUtil.Normalize"/>.</param>
    public FolderScanner(string root, int depthLimit = DefaultDepthLimit)
    {
        _root = root;
        _depthLimit = depthLimit;
    }

    public long FileCount => Interlocked.Read(ref _files);

    /// <summary>Folders below the root, links to folders included.</summary>
    public long FolderCount => Interlocked.Read(ref _folders);

    public long ByteCount => Interlocked.Read(ref _bytes);

    public long InaccessibleCount => Interlocked.Read(ref _inaccessible);

    public bool IsCompleted => _isCompleted;

    /// <summary>Looks up a finished folder by the path <see cref="Path.Combine(string, string)"/> builds from the root.</summary>
    public bool TryGetSize(string path, out FolderSize size) => _sizes.TryGetValue(path, out size);

    /// <exception cref="OperationCanceledException">The token was cancelled; the scan is left unfinished.</exception>
    public void Run(CancellationToken token)
    {
        var entries = new List<FsEntry>();
        var stack = new Stack<Frame>();
        stack.Push(new Frame(_root, 0, null));

        while (stack.Count > 0)
        {
            token.ThrowIfCancellationRequested();

            var frame = stack.Peek();
            frame.Subfolders ??= List(frame, entries);

            if (frame.Next < frame.Subfolders.Count)
            {
                var name = frame.Subfolders[frame.Next++];
                stack.Push(new Frame(Path.Combine(frame.Path, name), frame.Depth + 1, frame));
                continue;
            }

            stack.Pop();
            if (frame.Depth <= _depthLimit)
                _sizes[frame.Path] = new FolderSize(frame.Bytes, frame.IsPartial);
            if (frame.Parent is { } parent)
            {
                parent.Bytes += frame.Bytes;
                parent.IsPartial |= frame.IsPartial;
            }
        }

        _isCompleted = true;
    }

    private List<string> List(Frame frame, List<FsEntry> entries)
    {
        entries.Clear();
        if (DirectoryReader.Read(frame.Path, entries) != 0)
        {
            frame.IsPartial = true;
            Interlocked.Increment(ref _inaccessible);
        }

        var subfolders = new List<string>();
        foreach (var entry in entries)
        {
            if (entry.IsDirectory)
            {
                Interlocked.Increment(ref _folders);
                if (!entry.IsReparsePoint)
                    subfolders.Add(entry.Name);
            }
            else
            {
                Interlocked.Increment(ref _files);
                Interlocked.Add(ref _bytes, entry.Length);
                frame.Bytes += entry.Length;
            }
        }

        return subfolders;
    }

    private sealed class Frame
    {
        public Frame(string path, int depth, Frame? parent)
        {
            Path = path;
            Depth = depth;
            Parent = parent;
        }

        public string Path { get; }

        public int Depth { get; }

        public Frame? Parent { get; }

        public List<string>? Subfolders { get; set; }

        public int Next { get; set; }

        public long Bytes { get; set; }

        public bool IsPartial { get; set; }
    }
}
