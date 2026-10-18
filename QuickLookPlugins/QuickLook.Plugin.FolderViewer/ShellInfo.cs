using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace QuickLook.Plugin.FolderViewer;

/// <summary>Icons and type names from the shell, cached per extension.</summary>
internal static class ShellInfo
{
    private const string FolderKey = "<folder>";
    private const string LinkKey = "<link>";

    // These carry their own icon, so they are looked up per file instead of per extension.
    private static readonly HashSet<string> PerFileIconExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".exe", ".lnk", ".url", ".ico", ".cur", ".ani", ".scr", ".cpl", ".msc", ".appref-ms",
    };

    private static readonly Dictionary<string, string> TypeNames = new(StringComparer.OrdinalIgnoreCase);
    private static readonly Dictionary<string, ImageSource?> Icons = new(StringComparer.OrdinalIgnoreCase);

    private static readonly uint InfoSize = (uint)Marshal.SizeOf<NativeMethods.ShFileInfo>();

    public static string GetTypeName(string name, bool isDirectory)
    {
        var extension = isDirectory ? string.Empty : Path.GetExtension(name);
        var key = isDirectory ? FolderKey : extension;
        lock (TypeNames)
        {
            if (TypeNames.TryGetValue(key, out var cached))
                return cached;

            var info = default(NativeMethods.ShFileInfo);
            NativeMethods.SHGetFileInfo(
                isDirectory ? "folder" : "file" + extension,
                isDirectory ? FileAttributes.Directory : FileAttributes.Normal,
                ref info,
                InfoSize,
                NativeMethods.ShgfiTypeName | NativeMethods.ShgfiUseFileAttributes);

            var typeName = string.IsNullOrEmpty(info.TypeName)
                ? extension.TrimStart('.').ToUpperInvariant()
                : info.TypeName;
            TypeNames[key] = typeName;
            return typeName;
        }
    }

    /// <summary>A 16px icon; call on the UI thread.</summary>
    public static ImageSource? GetSmallIcon(FileNode node)
    {
        var extension = node.IsDirectory ? string.Empty : Path.GetExtension(node.Name);
        var perFile = !node.IsDirectory && PerFileIconExtensions.Contains(extension);
        var key = perFile ? node.FullPath : (node.IsDirectory ? FolderKey : extension) + (node.IsReparsePoint ? LinkKey : string.Empty);
        if (Icons.TryGetValue(key, out var cached))
            return cached;

        var attributes = node.IsDirectory ? FileAttributes.Directory : FileAttributes.Normal;
        var flags = NativeMethods.ShgfiIcon | NativeMethods.ShgfiSmallIcon;
        if (node.IsReparsePoint)
            flags |= NativeMethods.ShgfiLinkOverlay;

        var icon = perFile ? Load(node.FullPath, attributes, flags) : null;
        icon ??= Load(node.IsDirectory ? "folder" : "file" + extension, attributes, flags | NativeMethods.ShgfiUseFileAttributes);
        Icons[key] = icon;
        return icon;
    }

    /// <summary>The 32px icon of an actual folder, honouring a custom icon or a drive's icon.</summary>
    public static ImageSource? GetLargeIcon(string path) =>
        Load(path, FileAttributes.Directory, NativeMethods.ShgfiIcon | NativeMethods.ShgfiLargeIcon)
        ?? Load("folder", FileAttributes.Directory, NativeMethods.ShgfiIcon | NativeMethods.ShgfiLargeIcon | NativeMethods.ShgfiUseFileAttributes);

    private static ImageSource? Load(string path, FileAttributes attributes, uint flags)
    {
        var info = default(NativeMethods.ShFileInfo);
        if (NativeMethods.SHGetFileInfo(path, attributes, ref info, InfoSize, flags) == IntPtr.Zero || info.Icon == IntPtr.Zero)
            return null;

        try
        {
            var source = Imaging.CreateBitmapSourceFromHIcon(info.Icon, Int32Rect.Empty, BitmapSizeOptions.FromEmptyOptions());
            source.Freeze();
            return source;
        }
        finally
        {
            NativeMethods.DestroyIcon(info.Icon);
        }
    }
}
