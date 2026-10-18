using System.Globalization;
using Xunit;

namespace QuickLook.Plugin.FolderViewer.Tests;

public sealed class FormatTests
{
    [Theory]
    [InlineData(0L, "0 B")]
    [InlineData(1023L, "1023 B")]
    [InlineData(1024L, "1 KB")]
    [InlineData(1536L, "1.5 KB")]
    [InlineData(11010048L, "10.5 MB")]
    [InlineData(161061273600L, "150 GB")]
    public void Size_UsesThreeSignificantDigits(long bytes, string expected)
    {
        Assert.Equal(expected, Format.Size(bytes, CultureInfo.InvariantCulture));
    }

    [Theory]
    [InlineData(@"C:\", @"C:\")]
    [InlineData(@"C:\foo\", @"C:\foo")]
    [InlineData(@"\\server\share\", @"\\server\share")]
    public void Normalize_DropsTrailingSeparatorExceptOnDriveRoots(string path, string expected)
    {
        Assert.Equal(expected, PathUtil.Normalize(path));
    }
}
