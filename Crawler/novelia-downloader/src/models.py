"""Data models. No I/O, no project imports."""

import re
from dataclasses import dataclass, field
from typing import List, Optional

# The site's four file modes. `zh`/`jp` are single-language; the other two are
# the bilingual pairs, named for which language comes first in each pair.
# `jp` exists for web novels only — a library volume answers 400 for it, which is
# exactly why the bilingual-to-Japanese conversion has to exist.
MODES = ("jp", "zh", "zh-jp", "jp-zh")
BILINGUAL = ("zh-jp", "jp-zh")

WEB = "web"        # 网络小说 — serialised online, one work = many chapters
WENKU = "wenku"    # 文库小说 — published books, one work = many volume files


@dataclass
class Volume:
    """One published book inside a library work. `volume_id` is its filename."""
    volume_id: str
    total: int = 0
    baidu: int = 0
    youdao: int = 0
    gpt: int = 0
    sakura: int = 0

    @property
    def translated(self) -> int:
        return max(self.youdao, self.gpt, self.sakura, self.baidu)

    def order(self):
        """Sort by the volume number in the filename, so 2 precedes 10."""
        numbers = re.findall(r'(\d+)', self.volume_id)
        return (int(numbers[-1]) if numbers else 0, self.volume_id)


@dataclass
class Novel:
    """One work — the site groups every chapter of a series under a single id."""
    provider_id: str
    novel_id: str
    title_jp: str = ""
    title_zh: str = ""
    type: str = ""
    attentions: List[str] = field(default_factory=list)
    keywords: List[str] = field(default_factory=list)
    total: int = 0          # chapters the site has indexed
    jp: int = 0             # chapters with the Japanese source cached
    baidu: int = 0
    youdao: int = 0
    gpt: int = 0
    sakura: int = 0
    update_at: int = 0
    authors: List[str] = field(default_factory=list)
    introduction_jp: str = ""
    # Raw `{titleJp, titleZh, chapterId?}` entries in reading order. Only the
    # metadata endpoint fills this in; search results leave it empty.
    toc: List[dict] = field(default_factory=list)
    # WEB or WENKU. A library work carries `volumes` instead of chapter counts,
    # and is addressed by a bare id with no provider.
    kind: str = WEB
    volumes: List[Volume] = field(default_factory=list)
    publisher: str = ""
    # Output path component, made unique across a run by the CLI. Two works can
    # legitimately share a title, so the title alone cannot name the output.
    output_name: str = ""

    @property
    def key(self) -> str:
        if self.kind == WENKU:
            return f"wenku/{self.novel_id}"
        return f"{self.provider_id}/{self.novel_id}"

    @property
    def translated(self) -> int:
        """Chapters reachable through a bilingual download."""
        return max(self.youdao, self.gpt, self.sakura, self.baidu)

    def available_translations(self) -> List[str]:
        return [name for name, count in
                (("sakura", self.sakura), ("gpt", self.gpt),
                 ("youdao", self.youdao), ("baidu", self.baidu)) if count]

    def url(self, site: str) -> str:
        base = site.rstrip("/")
        if self.kind == WENKU:
            return f"{base}/wenku/{self.novel_id}"
        return f"{base}/novel/{self.provider_id}/{self.novel_id}"

    def display_title(self) -> str:
        return self.title_jp or self.title_zh or self.novel_id

    @property
    def label(self) -> str:
        return "文库" if self.kind == WENKU else "网络"

    def summary(self) -> str:
        if self.kind == WENKU:
            translated = sum(1 for v in self.volumes if v.translated)
            bits = [f"{len(self.volumes)} 巻"]
            if translated < len(self.volumes):
                bits.append(f"訳 {translated}")
            if self.publisher:
                bits.append(self.publisher)
            return " · ".join(bits)
        bits = [self.type or "?", f"JP {self.jp}"]
        if self.translated:
            bits.append("ZH " + "/".join(
                f"{n}{c}" for n, c in (("sakura", self.sakura), ("gpt", self.gpt),
                                       ("youdao", self.youdao)) if c))
        return " · ".join(bits)


@dataclass
class ConversionReport:
    """What convert_epub() actually changed, so a run can be verified."""
    chapters: int = 0
    kept_ja: int = 0
    dropped_zh: int = 0
    kept_blank: int = 0
    # Paragraphs belonging to the original published book (line breaks, captions)
    # rather than to either half of the translation.
    kept_original: int = 0
    deduped_headings: int = 0
    # Stylesheets copied back from the uploaded original (library volumes only).
    restored_css: int = 0
    vertical: bool = False
    warnings: List[str] = field(default_factory=list)

    def describe(self) -> str:
        text = (f"{self.chapters} chapter(s): kept {self.kept_ja} Japanese "
                f"paragraph(s) + {self.kept_blank} blank line(s), "
                f"dropped {self.dropped_zh} Chinese paragraph(s)")
        if self.kept_original:
            text += f", left {self.kept_original} original-markup paragraph(s) alone"
        if self.deduped_headings:
            text += f", merged {self.deduped_headings} duplicated heading(s)"
        if self.vertical:
            text += ("; vertical-rl restored from the publisher's own stylesheet"
                     if self.restored_css else "; vertical-rl applied")
        return text
