using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;

namespace QuickLook.Plugin.FolderViewer;

internal readonly struct FsEntry
{
    public FsEntry(string name, FileAttributes attributes, long length, DateTime lastWriteTimeUtc)
    {
        Name = name;
        Attributes = attributes;
        Length = length;
        LastWriteTimeUtc = lastWriteTimeUtc;
    }

    public string Name { get; }

    public FileAttributes Attributes { get; }

    public long Length { get; }

    /// <summary><see cref="DateTime.MinValue"/> when the file system reports no usable time.</summary>
    public DateTime LastWriteTimeUtc { get; }

    public bool IsDirectory => (Attributes & FileAttributes.Directory) != 0;

    /// <summary>Junctions and symbolic links; never descended into, so link cycles cannot trap a scan.</summary>
    public bool IsReparsePoint => (Attributes & FileAttributes.ReparsePoint) != 0;
}

/// <summary>
/// Lists directories through FindFirstFileEx: one call returns name, attributes, size and time for
/// every entry, and the \\?\ prefix lifts the 260-character limit of .NET Framework's IO APIs.
/// </summary>
internal static class DirectoryReader
{
    // DateTime.MaxValue as a FILETIME; larger values make DateTime.FromFileTimeUtc throw.
    private const long MaxFileTime = 2650467743999999999;

    /// <summary>
    /// Appends the entries of <paramref name="path"/> (a full path) to <paramref name="entries"/>.
    /// Returns 0, or the Win32 error that stopped the listing; entries read before an error are kept.
    /// </summary>
    public static int Read(string path, List<FsEntry> entries)
    {
        var extended = ToExtendedPath(path);
        var pattern = extended.EndsWith("\\", StringComparison.Ordinal) ? extended + "*" : extended + "\\*";

        using var handle = NativeMethods.FindFirstFileEx(
            pattern,
            NativeMethods.FindExInfoBasic,
            out var data,
            NativeMethods.FindExSearchNameMatch,
            IntPtr.Zero,
            NativeMethods.FindFirstExLargeFetch);
        if (handle.IsInvalid)
        {
            var error = Marshal.GetLastWin32Error();
            return error == NativeMethods.ErrorFileNotFound ? 0 : error;
        }

        do
        {
            if (data.FileName is "." or "..")
                continue;

            var length = ((long)data.FileSizeHigh << 32) | data.FileSizeLow;
            entries.Add(new FsEntry(data.FileName, data.FileAttributes, length, ToDateTime(data.LastWriteTime)));
        }
        while (NativeMethods.FindNextFile(handle, out data));

        var last = Marshal.GetLastWin32Error();
        return last == NativeMethods.ErrorNoMoreFiles ? 0 : last;
    }

    private static string ToExtendedPath(string path)
    {
        if (path.StartsWith(@"\\?\", StringComparison.Ordinal))
            return path;
        if (path.StartsWith(@"\\", StringComparison.Ordinal))
            return @"\\?\UNC\" + path.Substring(2);
        return @"\\?\" + path;
    }

    private static DateTime ToDateTime(NativeMethods.FileTime time)
    {
        var value = ((long)time.High << 32) | time.Low;
        return value is > 0 and <= MaxFileTime ? DateTime.FromFileTimeUtc(value) : DateTime.MinValue;
    }
}
