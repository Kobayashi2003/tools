# X Quick Actions

Chrome (MV3) extension for X / Twitter: gestures on photos, videos and GIFs
that download the original, like the post, or both. Grew out of
[ChinaGodMan's Twitter Media Downloader](https://github.com/ChinaGodMan/UserScripts/tree/main/twitter-media-downloader)
userscript.

## Triggers

Each is set in the popup to **Off / Download / Like / Both**:

| Trigger | Default |
| --- | --- |
| Double-click media | Download |
| Hold **Alt** (or Ctrl / Shift / Win) + click media | Download — hovered media is outlined (pink when it will only like) |

Plus a **download button** in each post's action bar that saves every media
item in the post, optionally liking it too.

- With double-click on, a single click on media opens it ~0.3 s later.
- Likes go to the post that owns the media (the quoted post for quoted media)
  and are never undone.
- Gestures save the clicked item or the whole post (popup → Saving).
- If a post and the post it quotes both have media, the button asks which to
  save (keys `1`–`3`, `Esc` cancels), or always takes this post / both. It is
  the only way to reach quoted media that X shows as just a `pic.x.com` link.
- **History** remembers downloaded posts (their button turns green). Export
  writes one post URL per line; Import merges such a file back in.

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
