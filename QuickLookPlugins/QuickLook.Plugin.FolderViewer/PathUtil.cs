using System;
using System.IO;

namespace QuickLook.Plugin.FolderViewer;

internal static class PathUtil
{
    /// <summary>
    /// A full path without a trailing separator (except for a drive root), so that paths built with
    /// <see cref="Path.Combine(string, string)"/> match between the tree and the scanner.
    /// </summary>
    public static string Normalize(string path)
    {
        string full;
        try
        {
            full = Path.GetFullPath(path);
        }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException)
        {
            full = path;
        }

        var root = Path.GetPathRoot(full) ?? string.Empty;
        return full.Length > root.Length
            ? full.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
            : full;
    }

    /// <summary>The folder's name, or for a drive root its label and letter, e.g. "Data (D:)".</summary>
    public static string DisplayName(string path)
    {
        var name = Path.GetFileName(path);
        if (!string.IsNullOrEmpty(name))
            return name;

        try
        {
            var label = new DriveInfo(path).VolumeLabel;
            var letter = path.TrimEnd(Path.DirectorySeparatorChar);
            return string.IsNullOrEmpty(label) ? letter : $"{label} ({letter})";
        }
        catch (Exception ex) when (ex is ArgumentException or IOException or UnauthorizedAccessException)
        {
            return path;
        }
    }
}
