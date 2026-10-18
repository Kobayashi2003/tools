using System.Collections.Generic;
using System.Linq;
using Xunit;

namespace QuickLook.Plugin.FolderViewer.Tests;

public sealed class DirectoryReaderTests
{
    [Fact]
    public void Read_ListsFilesAndFolders()
    {
        using var tree = new TempTree();
        tree.File("a.txt", 10);
        tree.Folder("sub");
        var entries = new List<FsEntry>();

        var error = DirectoryReader.Read(tree.Root, entries);

        Assert.Equal(0, error);
        Assert.Equal(new[] { "a.txt", "sub" }, entries.Select(e => e.Name).OrderBy(n => n));
        var file = entries.Single(e => e.Name == "a.txt");
        Assert.False(file.IsDirectory);
        Assert.Equal(10, file.Length);
        Assert.True(entries.Single(e => e.Name == "sub").IsDirectory);
    }

    [Fact]
    public void Read_EmptyFolder_ReturnsNothing()
    {
        using var tree = new TempTree();
        var entries = new List<FsEntry>();

        Assert.Equal(0, DirectoryReader.Read(tree.Root, entries));
        Assert.Empty(entries);
    }

    [Fact]
    public void Read_MissingFolder_ReturnsError()
    {
        using var tree = new TempTree();
        var entries = new List<FsEntry>();

        Assert.NotEqual(0, DirectoryReader.Read(tree.Path("missing"), entries));
        Assert.Empty(entries);
    }

    [Fact]
    public void Read_HandlesPathsLongerThan260Characters()
    {
        using var tree = new TempTree();
        var deep = string.Join("\\", Enumerable.Repeat(new string('d', 50), 6));
        var folder = tree.Path(deep);
        System.IO.Directory.CreateDirectory(@"\\?\" + folder);
        var entries = new List<FsEntry>();

        Assert.True(folder.Length > 260);
        Assert.Equal(0, DirectoryReader.Read(folder, entries));
    }
}
