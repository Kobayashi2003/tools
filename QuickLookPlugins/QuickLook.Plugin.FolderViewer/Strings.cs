using System.IO;
using QuickLook.Common.Helpers;

namespace QuickLook.Plugin.FolderViewer;

/// <summary>UI text from Translations.config, in QuickLook's language.</summary>
internal static class Strings
{
    private static readonly string File = Path.Combine(
        Path.GetDirectoryName(typeof(Strings).Assembly.Location) ?? string.Empty,
        "Translations.config");

    public static string Get(string id) => TranslationHelper.Get(id, File);
}
