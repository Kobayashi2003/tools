# X Quick Actions

Chrome extension for X: gestures on photos, videos and GIFs that download the original, like the
post, or both. Grew out of ChinaGodMan's
[Twitter Media Downloader](https://github.com/ChinaGodMan/UserScripts/tree/main/twitter-media-downloader).

## Use

Each trigger is set in the popup to **Off / Download / Like / Both**:

| Trigger                                            | Default  |
| -------------------------------------------------- | -------- |
| Double-click media                                 | Download |
| Hold **Alt** (or Ctrl / Shift / Win) + click media | Download |

A button in each post's action bar saves all its media. When a post and the post it quotes both
have media, it asks which to save (`1`–`3`, `Esc` cancels). Likes are never undone. **History**
marks downloaded posts and can be exported or imported as one URL per line.

## Filenames

```
twitter_{user-name}(@{user-id})_{date-time}_{status-id}_{file-type}
```

Tokens: `{user-name}` `{user-id}` `{status-id}` `{date-time}` (UTC, `YYYYMMDD-hhmmss`)
`{date-time-local}` `{file-type}` `{file-name}`. Multi-media posts get `-0`, `-1`, … unless
`{file-name}` is used; `/` creates subfolders. Each file is saved separately (no ZIP).

## Install

`chrome://extensions` → Developer mode → **Load unpacked** → select this folder, then reload open
X tabs.
