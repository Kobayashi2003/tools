# X Media Downloader

Chrome (MV3) extension for X / Twitter: double-click or modifier + click a
photo, video or GIF to save it in original quality, optionally liking the post
too. Based on [ChinaGodMan's Twitter Media Downloader](https://github.com/ChinaGodMan/UserScripts/tree/main/twitter-media-downloader)
userscript, with new triggers.

## Usage

| Trigger | Downloads |
| --- | --- |
| Double-click media | The clicked item (or the whole post — set in popup) |
| Hold **Alt** (or Ctrl / Shift / Win) + click | Same, instantly; hovered media is outlined |
| Download button in the post's action bar | Every media item in the post |

- With double-click on, a single click on media opens it ~0.3 s later.
- If a post and the post it quotes both have media, the button asks which to
  save — this post, the quoted one, or both (keys `1`–`3`, `Esc` cancels). The
  popup can make it always pick this post or both. This is the only way to
  reach quoted media that X shows as just a `pic.x.com` link.
- **Like when downloading** clicks the post's real ♥ button (falls back to the
  API) and never un-likes.
- **History** remembers downloaded posts (their button turns green); export it
  as a list of post URLs or clear it from the popup.

## Filenames

Default (same as the original userscript):

```
twitter_{user-name}(@{user-id})_{date-time}_{status-id}_{file-type}
→ twitter_ニャタBE(@emokakimasu)_20261007-090901_2107760095266505192_photo.jpg
```

Tokens: `{user-name}` `{user-id}` `{status-id}` `{date-time}` (UTC,
`YYYYMMDD-hhmmss`) `{date-time-local}` `{file-type}` (photo/video/gif)
`{file-name}`. Posts with several media get `-0`, `-1`, … appended unless
`{file-name}` is used. A `/` in the template creates subfolders; reserved
characters in names become full-width (`|` → `｜`).

## Notes

- Media URLs come from X's GraphQL `TweetResultByRestId` (`name=orig` photos,
  highest-bitrate MP4). When X rotates query ids or feature flags, the
  extension fills in missing flags and rediscovers ids from X's JS bundles.
  If the API fails, photos fall back to the page's image URL.
- No ZIP — multi-media posts save as separate files.

## Install

`chrome://extensions` → Developer mode → **Load unpacked** → select this
folder, then reload open X tabs.
