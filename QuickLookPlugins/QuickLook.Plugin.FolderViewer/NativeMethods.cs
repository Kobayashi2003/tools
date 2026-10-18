using System;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace QuickLook.Plugin.FolderViewer;

internal static class NativeMethods
{
    public const int ErrorFileNotFound = 2;
    public const int ErrorNoMoreFiles = 18;

    public const int FindExInfoBasic = 1;
    public const int FindExSearchNameMatch = 0;
    public const int FindFirstExLargeFetch = 2;

    public const uint ShgfiLargeIcon = 0x0;
    public const uint ShgfiSmallIcon = 0x1;
    public const uint ShgfiUseFileAttributes = 0x10;
    public const uint ShgfiIcon = 0x100;
    public const uint ShgfiTypeName = 0x400;
    public const uint ShgfiLinkOverlay = 0x8000;

    [StructLayout(LayoutKind.Sequential)]
    public struct FileTime
    {
        public uint Low;
        public uint High;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct Win32FindData
    {
        public FileAttributes FileAttributes;
        public FileTime CreationTime;
        public FileTime LastAccessTime;
        public FileTime LastWriteTime;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint Reserved0;
        public uint Reserved1;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string FileName;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 14)]
        public string AlternateFileName;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct ShFileInfo
    {
        public IntPtr Icon;
        public int IconIndex;
        public uint Attributes;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string DisplayName;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 80)]
        public string TypeName;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "FindFirstFileExW")]
    public static extern SafeFindHandle FindFirstFileEx(
        string fileName,
        int infoLevel,
        out Win32FindData findData,
        int searchOp,
        IntPtr searchFilter,
        int additionalFlags);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "FindNextFileW")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool FindNextFile(SafeFindHandle handle, out Win32FindData findData);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool FindClose(IntPtr handle);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, EntryPoint = "SHGetFileInfoW")]
    public static extern IntPtr SHGetFileInfo(
        string path,
        FileAttributes attributes,
        ref ShFileInfo info,
        uint infoSize,
        uint flags);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool DestroyIcon(IntPtr icon);

    /// <summary>Compares names the way File Explorer does, so "file2" sorts before "file10".</summary>
    [DllImport("shlwapi.dll", CharSet = CharSet.Unicode)]
    public static extern int StrCmpLogicalW(string x, string y);
}

internal sealed class SafeFindHandle : SafeHandleZeroOrMinusOneIsInvalid
{
    public SafeFindHandle()
        : base(true)
    {
    }

    protected override bool ReleaseHandle() => NativeMethods.FindClose(handle);
}
