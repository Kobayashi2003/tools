"""Turn a bilingual Novelia EPUB into a Japanese-only one, laid out for vertical reading.

Japanese paragraphs carry a dimming style (plus `lang="ja"` on web novels). A bare
`<p>` with text is the inserted translation and is dropped; an empty bare `<p>` is a
spacer and is kept; a `<p>` with other attributes belongs to the original book.
Headings have no marker, so duplicated pairs are resolved by kana.
"""

import posixpath
import re
import zipfile
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from .models import ConversionReport

_KANA = re.compile(r'[぀-ゟ゠-ヿ]')
_BODY = re.compile(r'(<body\b[^>]*>)(.*?)(</body>)', re.S)
_P = re.compile(r'<p\b([^>]*)>(.*?)</p>', re.S)
_HEADING = re.compile(r'<h([1-6])\b([^>]*)>(.*?)</h\1>', re.S)
_TAGS = re.compile(r'<[^>]+>')
_LANG_JA = re.compile(r'\blang\s*=\s*["\']ja["\']', re.I)
_OPACITY = re.compile(r'''\s*style\s*=\s*(?:"[^"]*opacity[^"]*"|'[^']*opacity[^']*')''', re.I)
# Expanded first, or `<p/>` would swallow everything up to the next `</p>`.
_SELF_CLOSING_P = re.compile(r'<p\b([^>]*?)\s*/>', re.I)

VERTICAL_CSS = """@charset "utf-8";

html {
  -epub-writing-mode: vertical-rl;
  -webkit-writing-mode: vertical-rl;
  writing-mode: vertical-rl;
}

body {
  font-family: "Hiragino Mincho ProN", "Yu Mincho", "MS Mincho", serif;
  line-height: 1.8;
  letter-spacing: 0.02em;
  margin: 0;
  padding: 1em;
  text-align: justify;
  line-break: strict;
  overflow-wrap: break-word;
}

h1, h2, h3 {
  font-weight: bold;
  margin: 0 0 1.5em 0;
  line-height: 1.4;
  page-break-before: always;
  break-before: page;
}

h1 { font-size: 1.4em; }

p {
  margin: 0;
  text-indent: 1em;
}

p:empty { text-indent: 0; height: 1em; }

.tcy {
  -epub-text-combine: horizontal;
  -webkit-text-combine: horizontal;
  text-combine-upright: all;
}

ruby > rt { font-size: 0.5em; }
"""

_CSS_HREF = "Styles/vertical.css"
_CSS_ID = "vertical-css"


def is_japanese(text: str) -> bool:
    return bool(_KANA.search(text))


def convert_document(html: str, report: ConversionReport, vertical: bool,
                     css_href: str = "", link_css: bool = True) -> str:
    match = _BODY.search(html)
    if not match:
        report.warnings.append("a document had no <body>; left untouched")
        return html

    open_tag, body, close_tag = match.groups()
    body = _SELF_CLOSING_P.sub(r'<p\1></p>', body)
    body = _strip_duplicate_headings(body, report)
    body = _strip_chinese_paragraphs(body, report)

    html = html[:match.start()] + open_tag + body + close_tag + html[match.end():]
    # <title> holds the Chinese chapter name; reuse the surviving Japanese heading.
    heading = _HEADING.search(body)
    if heading:
        title = _TAGS.sub("", heading.group(3)).strip()
        if title:
            html = re.sub(r'(<title>).*?(</title>)',
                          lambda m: m.group(1) + _escape(title) + m.group(2),
                          html, count=1, flags=re.S)
    html = _retag_language(html)
    if vertical and link_css and css_href:
        html = _link_stylesheet(html, css_href)
    return html


def _strip_duplicate_headings(body: str, report: ConversionReport) -> str:
    headings = list(_HEADING.finditer(body))
    if len(headings) < 2:
        return body

    drop: List[Tuple[int, int]] = []
    index = 0
    while index < len(headings) - 1:
        first, second = headings[index], headings[index + 1]
        if body[first.end():second.start()].strip() or first.group(1) != second.group(1):
            index += 1
            continue
        first_text = _TAGS.sub("", first.group(3)).strip()
        second_text = _TAGS.sub("", second.group(3)).strip()
        # Without kana on either side the titles match anyway; keep the first.
        if is_japanese(second_text) and not is_japanese(first_text):
            drop.append((first.start(), first.end()))
        else:
            drop.append((second.start(), second.end()))
        report.deduped_headings += 1
        index += 2

    for start, end in reversed(drop):
        body = body[:start] + body[end:]
    return body


def is_japanese_paragraph(attrs: str) -> bool:
    return bool(_OPACITY.search(attrs) or _LANG_JA.search(attrs))


def _strip_chinese_paragraphs(body: str, report: ConversionReport) -> str:
    def replace(match: re.Match) -> str:
        attrs, inner = match.group(1), match.group(2)
        if is_japanese_paragraph(attrs):
            report.kept_ja += 1
            return f"<p{_OPACITY.sub('', attrs)}>{inner}</p>"
        if attrs.strip():
            report.kept_original += 1
            return match.group(0)
        if not _TAGS.sub("", inner).strip():
            report.kept_blank += 1
            return match.group(0)
        report.dropped_zh += 1
        return ""

    body = _P.sub(replace, body)
    return re.sub(r'\n{3,}', '\n\n', body)


def _retag_language(html: str) -> str:
    html = re.sub(r'(<html\b[^>]*?)\slang="[^"]*"', r'\1', html, flags=re.I)
    html = re.sub(r'(<html\b[^>]*?)\sxml:lang="[^"]*"', r'\1', html, flags=re.I)
    return re.sub(r'<html\b', '<html lang="ja" xml:lang="ja"', html, count=1, flags=re.I)


def _link_stylesheet(html: str, href: str) -> str:
    if _CSS_HREF.split("/")[-1] in html:
        return html
    link = f'<link rel="stylesheet" type="text/css" href="{href}" />'
    if re.search(r'</head>', html, re.I):
        return re.sub(r'</head>', f'  {link}\n </head>', html, count=1, flags=re.I)
    return html


def _relative_href(from_document: str, to_file: str) -> str:
    return posixpath.relpath(to_file, posixpath.dirname(from_document) or ".")


def convert_epub(source: Path, destination: Path, vertical: bool = True,
                 title_jp: str = "", introduction_jp: str = "",
                 authors: Optional[List[str]] = None,
                 toc: Optional[List[dict]] = None,
                 restore_css_from: Optional[Path] = None) -> ConversionReport:
    """Write a Japanese-only copy of `source` to `destination`.

    `toc` is the metadata table of contents used to relabel navigation in Japanese.
    `restore_css_from` is a library volume's uploaded original: the site empties its
    stylesheets, so the publisher's CSS is copied back instead of generated.
    """
    report = ConversionReport(vertical=vertical)
    with zipfile.ZipFile(source) as archive:
        names = archive.namelist()
        payload: Dict[str, bytes] = {name: archive.read(name) for name in names}

    original_css: Dict[str, bytes] = {}
    if vertical and restore_css_from and Path(restore_css_from).exists():
        with zipfile.ZipFile(restore_css_from) as reference:
            for name in reference.namelist():
                if name.lower().endswith(".css"):
                    original_css[name] = reference.read(name)
    restorable = {name: data for name, data in original_css.items()
                  if name in payload and not payload[name].strip() and data.strip()}

    opf_name = next((n for n in names if n.lower().endswith(".opf")), "")
    css_root = opf_name.rsplit("/", 1)[0] if "/" in opf_name else ""
    css_name = f"{css_root}/{_CSS_HREF}" if css_root else _CSS_HREF

    output: Dict[str, bytes] = {}
    for name in names:
        data = payload[name]
        lower = name.lower()
        if lower.endswith((".xhtml", ".html")):
            text = data.decode("utf-8")
            if name.endswith("nav.xhtml"):
                text = _convert_nav(text, report, title_jp, toc or [])
                text = _retag_language(text)
            else:
                report.chapters += 1
                text = convert_document(text, report, vertical,
                                        css_href=_relative_href(name, css_name),
                                        link_css=not restorable)
            data = text.encode("utf-8")
        elif lower.endswith(".css") and name in restorable:
            data = restorable[name]
            report.restored_css += 1
        elif lower.endswith(".opf"):
            data = _convert_opf(data.decode("utf-8"), vertical, title_jp,
                                introduction_jp, authors or [],
                                add_css=not restorable).encode("utf-8")
        elif lower.endswith(".ncx"):
            data = _convert_ncx(data.decode("utf-8"), title_jp, toc or []).encode("utf-8")
        output[name] = data

    if vertical and not restorable:
        output[css_name] = VERTICAL_CSS.encode("utf-8")

    destination.parent.mkdir(parents=True, exist_ok=True)
    temp = destination.with_suffix(destination.suffix + ".part")
    with zipfile.ZipFile(temp, "w", zipfile.ZIP_DEFLATED) as archive:
        if "mimetype" in output:
            archive.writestr(zipfile.ZipInfo("mimetype"), output.pop("mimetype"),
                             compress_type=zipfile.ZIP_STORED)
        for name, data in output.items():
            archive.writestr(name, data)
    temp.replace(destination)
    return report


def _convert_nav(html: str, report: ConversionReport, title_jp: str,
                 toc: List[dict]) -> str:
    """Relabel nav entries by position: `<span>` volume headings, `<a>` chapters."""
    if title_jp:
        html = re.sub(r'(<title>).*?(</title>)', lambda m: m.group(1) + _escape(title_jp) + m.group(2),
                      html, count=1, flags=re.S)
        html = re.sub(r'(<h2[^>]*>).*?(</h2>)', lambda m: m.group(1) + _escape(title_jp) + m.group(2),
                      html, count=1, flags=re.S)
    if not toc:
        return html

    pattern = re.compile(r'(<li>\s*)(<span>|<a\b[^>]*>)(.*?)(</span>|</a>)', re.S)
    position = [0]

    def relabel(match: re.Match) -> str:
        head, open_tag, text, close_tag = match.groups()
        wants_chapter = open_tag.startswith("<a")
        index = position[0]
        while index < len(toc):
            entry = toc[index]
            if bool(entry.get("chapterId")) == wants_chapter:
                position[0] = index + 1
                label = entry.get("titleJp") or entry.get("titleZh") or text
                return f"{head}{open_tag}{_escape(label)}{close_tag}"
            index += 1
        return match.group(0)

    return pattern.sub(relabel, html)


def _convert_ncx(xml: str, title_jp: str, toc: List[dict]) -> str:
    xml = re.sub(r'(<ncx\b[^>]*?)\sxml:lang="[^"]*"', r'\1', xml, flags=re.I)
    if title_jp:
        xml = re.sub(r'(<docTitle>\s*<text>).*?(</text>)',
                     lambda m: m.group(1) + _escape(title_jp) + m.group(2),
                     xml, count=1, flags=re.S)
    chapters = iter([e for e in toc if e.get("chapterId")])

    def relabel(match: re.Match) -> str:
        for entry in chapters:
            label = entry.get("titleJp") or entry.get("titleZh")
            if label:
                return match.group(1) + _escape(label) + match.group(2)
            break
        return match.group(0)

    return re.sub(r'(<navLabel>\s*<text>).*?(</text>)', relabel, xml, flags=re.S)


def _convert_opf(xml: str, vertical: bool, title_jp: str,
                 introduction_jp: str, authors: List[str],
                 add_css: bool = True) -> str:
    xml = re.sub(r'<dc:language>[^<]*</dc:language>', '<dc:language>ja</dc:language>',
                 xml, count=1)
    if title_jp:
        xml = re.sub(r'<dc:title>.*?</dc:title>',
                     f'<dc:title>{_escape(title_jp)}</dc:title>', xml, count=1, flags=re.S)
    if introduction_jp:
        xml = re.sub(r'<dc:description>.*?</dc:description>',
                     f'<dc:description>{_escape(introduction_jp)}</dc:description>',
                     xml, count=1, flags=re.S)
    if authors:
        xml = re.sub(r'<dc:creator>.*?</dc:creator>',
                     f'<dc:creator>{_escape(", ".join(authors))}</dc:creator>',
                     xml, count=1, flags=re.S)

    if vertical:
        # Library volumes arrive with the writing mode reversed; overwrite it.
        if "primary-writing-mode" in xml:
            xml = re.sub(r'(<meta\b[^>]*primary-writing-mode[^>]*content=")[^"]*"',
                         r'\1vertical-rl"', xml)
        else:
            xml = xml.replace(
                "</metadata>",
                '<meta name="primary-writing-mode" content="vertical-rl"></meta>'
                '<meta property="rendition:layout">reflowable</meta>'
                '<meta property="rendition:spread">auto</meta></metadata>', 1)
        if add_css and _CSS_ID not in xml:
            xml = xml.replace(
                "</manifest>",
                f'<item href="{_CSS_HREF}" id="{_CSS_ID}" media-type="text/css"></item>'
                "</manifest>", 1)
        xml = re.sub(r'(<spine\b[^>]*\bpage-progression-direction=)["\'][^"\']*["\']',
                     r'\1"rtl"', xml, count=1)
        xml = re.sub(r'<spine\b(?![^>]*page-progression-direction)',
                     '<spine page-progression-direction="rtl"', xml, count=1)
    return xml


def _escape(text: str) -> str:
    return (text.replace("&", "&amp;").replace("<", "&lt;")
                .replace(">", "&gt;").replace('"', "&quot;"))


# Whitespace is ignored: the site pretty-prints bilingual XHTML, even inside <ruby>.
_SPACE = re.compile(r'\s+')


def chapter_paragraphs(path: Path, japanese_only: bool = False) -> Dict[str, List[str]]:
    result: Dict[str, List[str]] = {}
    with zipfile.ZipFile(path) as archive:
        for name in sorted(archive.namelist()):
            if not name.lower().endswith((".xhtml", ".html")) or name.endswith("nav.xhtml"):
                continue
            body_match = _BODY.search(archive.read(name).decode("utf-8"))
            if not body_match:
                continue
            paragraphs = []
            body = _SELF_CLOSING_P.sub(r'<p\1></p>', body_match.group(2))
            for attrs, inner in _P.findall(body):
                if japanese_only and not is_japanese_paragraph(attrs):
                    continue
                paragraphs.append(_SPACE.sub("", _TAGS.sub("", inner)))
            result[name] = paragraphs
    return result


def verify_against_jp(converted: Path, reference: Path,
                      reference_name: str = "the site's own Japanese export"
                      ) -> Tuple[bool, str]:
    got = chapter_paragraphs(converted)
    want = chapter_paragraphs(reference)
    if not want:
        return False, "reference file has no chapters"
    missing = [n for n in want if n not in got]
    if missing:
        return False, f"{len(missing)} chapter(s) missing, e.g. {missing[0]}"
    extra = [n for n in got if n not in want]
    if extra:
        return False, f"{len(extra)} unexpected chapter(s), e.g. {extra[0]}"
    differing = [n for n in want if got[n] != want[n]]
    if differing:
        name = differing[0]
        return False, (f"{len(differing)} chapter(s) differ, e.g. {name} "
                       f"({len(got[name])} vs {len(want[name])} paragraphs)")
    return True, f"identical to {reference_name} across {len(want)} chapter(s)"
