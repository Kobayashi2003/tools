# QuickLook plugins

Plugins for [QuickLook](https://github.com/QL-Win/QuickLook) 4.x, which runs on .NET Framework 4.6.2
with WPF.

| Plugin | Previews |
| --- | --- |
| [QuickLook.Plugin.FolderViewer](QuickLook.Plugin.FolderViewer) | Folders and drives, as a tree with sizes |
| [QuickLook.Plugin.EpubViewer](QuickLook.Plugin.EpubViewer) | `.epub`, `.azw3` and KF8 `.mobi` books, in a full reader |

## Build and install

You need the .NET SDK 8 or newer and an installed QuickLook. EpubViewer also needs Node 24 and
pnpm, because `build.ps1` builds its `web/` front end first. The build references that QuickLook's
`QuickLook.Common.dll` instead of shipping a copy. It looks for QuickLook in
`$env:SCOOP\apps\quicklook\current` (or `~\scoop\...`); pass `-QuickLookDir` for any other location.

```powershell
./build.ps1             # every plugin -> dist\<name>.qlplugin
./build.ps1 -Install    # also install into QuickLook (stops and restarts it)
```

To install a `.qlplugin` by hand, preview it in QuickLook and click Install.

## Checks

Run these before handing off a change:

```powershell
dotnet build QuickLookPlugins.sln
dotnet test QuickLookPlugins.sln
dotnet format QuickLookPlugins.sln --verify-no-changes
# in QuickLook.Plugin.EpubViewer/web
pnpm typecheck; pnpm lint; pnpm format:check; pnpm build
```

A plugin's version is set in two places, its `.csproj` and `QuickLook.Plugin.Metadata.config`.
Change both together.

## FolderViewer

- The preview opens on the folder's first level. A subfolder is read only when you expand it, so
  large folders open at once.
- A background scan adds up the total size and file count, then fills in each folder's size. It
  stops when the preview closes.
- Junctions and symbolic links are listed but not followed. A size shown as `≥` is incomplete
  because some folder below it could not be read.
- Double-click a folder to expand or collapse it; double-click a file to open it. The right-click
  menu has Open, Show in File Explorer and Copy path. Click a column header to sort by it.
- The UI text is in English, Chinese and Japanese and follows QuickLook's language.

## EpubViewer

- The reader is a copy of `components/data-display/epub-reader`, cut down for previewing, in
  `web/src/epub-reader` (see its README for what was removed). It is bundled by Vite and runs in
  WebView2, which shares QuickLook HtmlViewer's browser data folder.
- The plugin serves the bundle and the book itself from `https://epubviewer.quicklook/`, so the
  page needs no file access. The fixed origin lets the reader remember each book's position.
- Links in a book open in the default browser. The reader's fullscreen button maximizes the
  QuickLook window.
- Click the preview once before using the keyboard: QuickLook does not give its window focus.
