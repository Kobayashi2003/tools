// Pages on the sites the posts come from. `c` is a creator detail (service, user_id,
// fanbox_creator_id); a link that cannot be built is null.
const enc = encodeURIComponent;

export const pawchive = (c, postId) =>
  `https://pawchive.pw/${enc(c.service)}/user/${enc(c.user_id)}${postId ? `/post/${enc(postId)}` : ''}`;

export const fanbox = (c, postId) =>
  c.fanbox_creator_id ? `https://www.fanbox.cc/@${enc(c.fanbox_creator_id)}${postId ? `/posts/${enc(postId)}` : ''}` : null;

// The creator's home outside Pawchive and Fanbox: pixiv shares Fanbox's userId.
export function origin(c, postId) {
  if (c.service === 'fanbox') return postId ? null : { label: 'pixiv', url: `https://www.pixiv.net/users/${enc(c.user_id)}` };
  if (c.service === 'patreon') {
    return { label: 'Patreon', url: postId ? `https://www.patreon.com/posts/${enc(postId)}` : `https://www.patreon.com/user?u=${enc(c.user_id)}` };
  }
  return null;
}
