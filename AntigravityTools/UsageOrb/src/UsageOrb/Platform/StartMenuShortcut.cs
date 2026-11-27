using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;

namespace UsageOrb.Platform;

internal static class StartMenuShortcut
{
    internal const string FileName = "UsageOrb.lnk";
    private const string Description = "Open the Antigravity UsageOrb console (managed by UsageOrb)";
    private const string Arguments = "--console";

    public static string? TrySetRegistration(bool enabled)
    {
        var programs = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
        var executable = Environment.ProcessPath;
        if (string.IsNullOrEmpty(programs) || executable is null) return "The Start menu or UsageOrb path is unavailable.";

        try
        {
            SetRegistration(programs, executable, enabled);
            return null;
        }
        catch (InvalidOperationException)
        {
            return "An existing UsageOrb shortcut is managed outside this app.";
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or COMException)
        {
            return "The Start menu shortcut could not be updated.";
        }
    }

    internal static void SetRegistration(string programs, string executable, bool enabled)
    {
        var path = Path.Combine(programs, FileName);
        var existing = File.Exists(path);
        if (!enabled && !existing) return;

        if (existing)
        {
            (string Target, string Arguments, string Description) shortcut;
            try
            {
                shortcut = ReadShortcut(path);
            }
            catch (COMException) when (!enabled)
            {
                return;
            }
            if (shortcut.Description != Description)
            {
                if (enabled) throw new InvalidOperationException();
                return;
            }
            if (!enabled)
            {
                File.Delete(path);
                return;
            }
            if (string.Equals(shortcut.Target, executable, StringComparison.OrdinalIgnoreCase) && shortcut.Arguments == Arguments) return;
        }

        Directory.CreateDirectory(programs);
        var draft = Path.Combine(programs, $".UsageOrb-{Guid.NewGuid():N}.lnk");
        var link = (IShellLinkW)new ShellLink();
        try
        {
            link.SetPath(executable);
            link.SetWorkingDirectory(Path.GetDirectoryName(executable)!);
            link.SetArguments(Arguments);
            link.SetDescription(Description);
            ((IPersistFile)link).Save(draft, false);
            File.Move(draft, path, overwrite: existing);
        }
        finally
        {
            Marshal.FinalReleaseComObject(link);
            File.Delete(draft);
        }
    }

    internal static (string Target, string Arguments, string Description) ReadShortcut(string path)
    {
        var link = (IShellLinkW)new ShellLink();
        try
        {
            ((IPersistFile)link).Load(path, 0);
            var target = new StringBuilder(32_768);
            var arguments = new StringBuilder(1_024);
            var description = new StringBuilder(1_024);
            const uint rawPath = 4;
            link.GetPath(target, target.Capacity, 0, rawPath);
            link.GetArguments(arguments, arguments.Capacity);
            link.GetDescription(description, description.Capacity);
            return (target.ToString(), arguments.ToString(), description.ToString());
        }
        finally
        {
            Marshal.FinalReleaseComObject(link);
        }
    }

    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    private class ShellLink;

    [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellLinkW
    {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int capacity, nint findData, uint flags);
        void GetIDList(out nint itemIdList);
        void SetIDList(nint itemIdList);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder description, int capacity);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string description);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder directory, int capacity);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string directory);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder arguments, int capacity);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string arguments);
        void GetHotkey(out ushort hotkey);
        void SetHotkey(ushort hotkey);
        void GetShowCmd(out int showCommand);
        void SetShowCmd(int showCommand);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder iconPath, int capacity, out int iconIndex);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string iconPath, int iconIndex);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string relativePath, uint reserved);
        void Resolve(nint owner, uint flags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string path);
    }
}
