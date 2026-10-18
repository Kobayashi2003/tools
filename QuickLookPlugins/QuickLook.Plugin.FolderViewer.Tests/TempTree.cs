using System;
using System.Diagnostics;
using System.IO;

namespace QuickLook.Plugin.FolderViewer.Tests;

/// <summary>A throwaway folder tree under %TEMP%, deleted on dispose.</summary>
internal sealed class TempTree : IDisposable
{
    public TempTree()
    {
        Root = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "FolderViewerTests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Root);
    }

    public string Root { get; }

    public string Path(string relative) => System.IO.Path.Combine(Root, relative);

    public string File(string relative, int size)
    {
        var path = Path(relative);
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(path)!);
        System.IO.File.WriteAllBytes(path, new byte[size]);
        return path;
    }

    public string Folder(string relative) => Directory.CreateDirectory(Path(relative)).FullName;

    /// <summary>mklink /J needs no elevation, unlike a symbolic link.</summary>
    public string Junction(string relative, string target)
    {
        var path = Path(relative);
        Cmd($"mklink /J \"{path}\" \"{target}\"");
        return path;
    }

    public void Dispose()
    {
        // .NET Framework's Directory.Delete fails on junctions and on paths over 260 characters; rd
        // handles both and removes a junction without following it.
        Cmd($"rd /s /q \"\\\\?\\{Root}\"");
    }

    private static void Cmd(string command)
    {
        using var process = Process.Start(new ProcessStartInfo("cmd.exe", "/c " + command)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
        })!;
        process.StandardOutput.ReadToEnd();
        process.WaitForExit();
        if (process.ExitCode != 0)
            throw new InvalidOperationException($"'{command}' exited with {process.ExitCode}.");
    }
}
