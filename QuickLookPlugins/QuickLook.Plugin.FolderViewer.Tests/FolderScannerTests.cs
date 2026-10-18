using System;
using System.Threading;
using Xunit;

namespace QuickLook.Plugin.FolderViewer.Tests;

public sealed class FolderScannerTests
{
    [Fact]
    public void Run_TotalsEachFolderBottomUp()
    {
        using var tree = new TempTree();
        tree.File("a.bin", 10);
        tree.File(@"x\b.bin", 20);
        tree.File(@"x\y\c.bin", 30);
        var scanner = new FolderScanner(tree.Root);

        scanner.Run(CancellationToken.None);

        Assert.True(scanner.IsCompleted);
        Assert.Equal(3, scanner.FileCount);
        Assert.Equal(2, scanner.FolderCount);
        Assert.Equal(60, scanner.ByteCount);
        Assert.Equal(60, Size(scanner, tree.Root));
        Assert.Equal(50, Size(scanner, tree.Path("x")));
        Assert.Equal(30, Size(scanner, tree.Path(@"x\y")));
        Assert.Equal(0, scanner.InaccessibleCount);
    }

    [Fact]
    public void Run_DoesNotFollowJunctions()
    {
        using var tree = new TempTree();
        tree.File("a.bin", 5);
        var loop = tree.Junction("loop", tree.Root);
        var scanner = new FolderScanner(tree.Root);

        scanner.Run(CancellationToken.None);

        Assert.Equal(1, scanner.FolderCount);
        Assert.Equal(5, scanner.ByteCount);
        Assert.False(scanner.TryGetSize(loop, out _));
    }

    [Fact]
    public void Run_KeepsSizesOnlyUpToTheDepthLimit()
    {
        using var tree = new TempTree();
        tree.File(@"a\b\c\d.bin", 7);
        var scanner = new FolderScanner(tree.Root, depthLimit: 1);

        scanner.Run(CancellationToken.None);

        Assert.Equal(7, Size(scanner, tree.Path("a")));
        Assert.False(scanner.TryGetSize(tree.Path(@"a\b"), out _));
        Assert.Equal(7, scanner.ByteCount);
    }

    [Fact]
    public void Run_MissingRoot_IsPartial()
    {
        using var tree = new TempTree();
        var missing = tree.Path("missing");
        var scanner = new FolderScanner(missing);

        scanner.Run(CancellationToken.None);

        Assert.Equal(1, scanner.InaccessibleCount);
        Assert.True(scanner.TryGetSize(missing, out var size));
        Assert.True(size.IsPartial);
    }

    [Fact]
    public void Run_Cancelled_StopsUnfinished()
    {
        using var tree = new TempTree();
        var scanner = new FolderScanner(tree.Root);

        Assert.Throws<OperationCanceledException>(() => scanner.Run(new CancellationToken(true)));
        Assert.False(scanner.IsCompleted);
    }

    private static long Size(FolderScanner scanner, string path)
    {
        Assert.True(scanner.TryGetSize(path, out var size), path);
        return size.Bytes;
    }
}
