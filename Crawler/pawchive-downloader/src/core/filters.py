from typing import Dict, List

from .models import Post


class PostFilter:
    """Filters a list of posts against a config dict. Supported keys:

        include_keywords      : list[str]  keep if title contains ANY
        exclude_keywords      : list[str]  drop if title contains ANY
        require_all_keywords  : list[str]  keep only if title contains ALL
        require_files         : bool       keep only posts with file/attachments
        require_attachments   : bool       keep only posts with attachments
        published_after       : "YYYY-MM-DD"
        published_before      : "YYYY-MM-DD"
    """

    @staticmethod
    def _has_kw(post: Post, kw: str) -> bool:
        return kw.lower() in post.title.lower()

    @staticmethod
    def apply(posts: List[Post], cfg: Dict) -> List[Post]:
        if not cfg:
            return posts

        include = cfg.get("include_keywords") or []
        exclude = cfg.get("exclude_keywords") or []
        require_all = cfg.get("require_all_keywords") or []
        after = cfg.get("published_after")
        before = cfg.get("published_before")

        out = []
        for p in posts:
            if include and not any(PostFilter._has_kw(p, k) for k in include):
                continue
            if exclude and any(PostFilter._has_kw(p, k) for k in exclude):
                continue
            if require_all and not all(PostFilter._has_kw(p, k) for k in require_all):
                continue
            if cfg.get("require_files") and not (p.file or p.attachments):
                continue
            if cfg.get("require_attachments") and not p.attachments:
                continue
            pub = (p.published or "")[:10]
            if after and not (pub > after):
                continue
            if before and not (pub < before):
                continue
            out.append(p)
        return out
