using System.Linq;
using System.Threading;
using Xunit;

namespace QuickLook.Plugin.FolderViewer.Tests;

public sealed class FolderTreeTests
{
    [Fact]
    public void LoadRoot_PutsFoldersFirstInExplorerOrder()
    {
        using var tree = new TempTree();
        tree.File("file10.txt", 1);
        tree.File("file2.txt", 1);
        tree.Folder("zeta");

        var folderTree = Load(tree.Root);

        Assert.Equal(new[] { "zeta", "file2.txt", "file10.txt" }, Names(folderTree));
    }

    [Fact]
    public void ExpandAndCollapse_KeepRowsInTreeOrder()
    {
        using var tree = new TempTree();
        tree.File(@"a\b\c.txt", 1);
        tree.File(@"a\d.txt", 1);
        tree.File("e.txt", 1);
        var folderTree = Load(tree.Root);
        var a = folderTree.Rows[0];

        folderTree.Expand(a);
        Assert.Equal(new[] { "a", "b", "d.txt", "e.txt" }, Names(folderTree));
        Assert.Equal(1, folderTree.Rows[1].Depth);

        folderTree.Expand(folderTree.Rows[1]);
        Assert.Equal(new[] { "a", "b", "c.txt", "d.txt", "e.txt" }, Names(folderTree));

        folderTree.Collapse(a);
        Assert.Equal(new[] { "a", "e.txt" }, Names(folderTree));

        // The inner folder stays expanded and reappears with its parent.
        folderTree.Expand(a);
        Assert.Equal(new[] { "a", "b", "c.txt", "d.txt", "e.txt" }, Names(folderTree));
    }

    [Fact]
    public void Expand_EmptyFolder_LeavesItUnexpandable()
    {
        using var tree = new TempTree();
        tree.Folder("empty");
        var folderTree = Load(tree.Root);
        var empty = folderTree.Rows[0];

        folderTree.Expand(empty);

        Assert.False(empty.IsExpanded);
        Assert.False(empty.CanExpand);
    }

    [Fact]
    public void SortBy_Size_StartsLargestFirstThenFlips()
    {
        using var tree = new TempTree();
        tree.File("small.bin", 1);
        tree.File("big.bin", 100);
        var folderTree = Load(tree.Root);

        folderTree.SortBy(SortKey.Size);
        Assert.Equal(new[] { "big.bin", "small.bin" }, Names(folderTree));

        folderTree.SortBy(SortKey.Size);
        Assert.Equal(new[] { "small.bin", "big.bin" }, Names(folderTree));
    }

    [Fact]
    public void RefreshSizes_FillsFolderSizesOnceScanned()
    {
        using var tree = new TempTree();
        tree.File(@"sub\a.bin", 42);
        var scanner = new FolderScanner(tree.Root);
        var folderTree = new FolderTree(tree.Root, scanner);
        folderTree.LoadRoot();
        folderTree.ShowRoot();
        var sub = folderTree.Rows[0];
        Assert.True(sub.IsSizePending);
        Assert.Null(sub.Length);

        scanner.Run(CancellationToken.None);
        folderTree.RefreshSizes();

        Assert.False(sub.IsSizePending);
        Assert.Equal(42, sub.Length);
    }

    private static FolderTree Load(string root)
    {
        var scanner = new FolderScanner(root);
        var folderTree = new FolderTree(root, scanner);
        folderTree.LoadRoot();
        folderTree.ShowRoot();
        return folderTree;
    }

    private static string[] Names(FolderTree folderTree) => folderTree.Rows.Select(n => n.Name).ToArray();
}
