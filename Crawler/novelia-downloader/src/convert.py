"""Turn a bilingual EPUB into a Japanese-only one, laid out for vertical reading.

The site builds bilingual files two different ways, and both are handled here:

  web novels (网络小说)   Japanese paragraphs get `lang="ja"` and a dimming style;
                          Chinese ones are bare `<p>`.
  library novels (文库)   The published EPUB is reused as-is, so its own markup
                          survives. Japanese paragraphs keep their original
                          attributes plus the dimming style — and carry *no*
                          `lang` — while Chinese ones are bare `<p>`.

The one marker present in both is the dimming style, so that is what identifies
Japanese. Everything else follows from it:

  * A bare `<p>` holding text is the inserted translation, and is dropped. On a
    library volume the counts come out exactly 1:1 against the Japanese ones,
    which is what confirms the rule.
  * A bare but *empty* `<p>` is a spacer that the Japanese reference build keeps
    too, so it is kept here — dropping them silently reflows the text.
  * A paragraph with attributes but no dimming style belongs to the original
    book (line breaks, captions) and is left alone.

Headings carry no marker at all and are emitted Japanese-first in both bilingual
modes, so they are matched by kana instead of by position.

Conversion is checked against a reference build of the same volume —
`mode=jp` for a web novel, the uploaded original for a library volume.
"""

import posixpath
import re
import zipfile
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from .models import ConversionReport

_KANA = re.compile(r'[぀-ゟ゠-ヿ]')            # hiragana / katakana: never Chinese
_BODY = re.compile(r'(<body\b[^>]*>)(.*?)(</body>)', re.S)
_P = re.compile(r'<p\b([^>]*)>(.*?)</p>', re.S)
_HEADING = re.compile(r'<h([1-6])\b([^>]*)>(.*?)</h\1>', re.S)
_TAGS = re.compile(r'<[^>]+>')
_LANG_JA = re.compile(r'\blang\s*=\s*["\']ja["\']', re.I)
# Either quoting style: the marker is what separates the two languages, so
# missing it would silently leave Chinese text in a "Japanese-only" book.
_OPACITY = re.compile(r'''\s*style\s*=\s*(?:"[^"]*opacity[^"]*"|'[^']*opacity[^']*')''', re.I)
# `<p/>` is a valid empty paragraph, but it would otherwise be read as an
# opening tag whose body runs to the next `</p>` — swallowing the paragraph
# after it, Chinese included.
_SELF_CLOSING_P = re.compile(r'<p\b([^>]*?)\s*/>', re.I)

VERTICAL_CSS = """@charset "utf-8";

/* Japanese vertical writing: right-to-left columns, pages turn right-to-left. */
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

/* Blank spacer paragraphs carry the original's pacing; keep them visible. */
p:empty { text-indent: 0; height: 1em; }

/* Runs of Western digits read upright inside vertical text. */
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


# ---- per-document conversion ----

def convert_document(html: str, report: ConversionReport, vertical: bool,
                     css_href: str = "", link_css: bool = True) -> str:
    """Strip the Chinese half of one chapter and retag it as Japanese."""
    match = _BODY.search(html)
    if not match:
        report.warnings.append("a document had no <body>; left untouched")
        return html

    open_tag, body, close_tag = match.groups()
    body = _SELF_CLOSING_P.sub(r'<p\1></p>', body)
    body = _strip_duplicate_headings(body, report)
    body = _strip_chinese_paragraphs(body, report)

    html = html[:match.start()] + open_tag + body + close_tag + html[match.end():]
    # <head><title> holds the Chinese chapter name; the heading that survived
    # deduplication is the Japanese one, so reuse it.
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
    """Collapse the Japanese/Chinese heading pair down to the Japanese one."""
    headings = list(_HEADING.finditer(body))
    if len(headings) < 2:
        return body

    drop: List[Tuple[int, int]] = []
    index = 0
    while index < len(headings) - 1:
        first, second = headings[index], headings[index + 1]
        # Only a genuinely adjacent pair (nothing but whitespace between them).
        if body[first.end():second.start()].strip():
            index += 1
            continue
        if first.group(1) != second.group(1):
            index += 1
            continue
        first_text = _TAGS.sub("", first.group(3)).strip()
        second_text = _TAGS.sub("", second.group(3)).strip()
        # Kana proves which side is Japanese; when neither has kana the two are
        # the same string anyway (numeric titles), so position decides.
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
    """The dimming style marks the Japanese half in both site layouts; web
    novels additionally tag it `lang="ja"`."""
    return bool(_OPACITY.search(attrs) or _LANG_JA.search(attrs))


def _strip_chinese_paragraphs(body: str, report: ConversionReport) -> str:
    def replace(match: re.Match) -> str:
        attrs, inner = match.group(1), match.group(2)
        if is_japanese_paragraph(attrs):
            report.kept_ja += 1
            # The dimming only makes sense next to a translation.
            return f"<p{_OPACITY.sub('', attrs)}>{inner}</p>"
        if attrs.strip():
            # Belongs to the original book, not to the translation.
            report.kept_original += 1
            return match.group(0)
        if not _TAGS.sub("", inner).strip():
            report.kept_blank += 1
            return match.group(0)
        report.dropped_zh += 1
        return ""

    body = _P.sub(replace, body)
    # Collapse the blank lines left behind by removed paragraphs.
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
    """Link one archive member from another.

    Counting the slashes in the document's own path only works when it sits
    exactly one level below the OPF; an EPUB with the OPF at the root and its
    chapters in a subfolder needs a real relative path, or the stylesheet
    silently fails to load.
    """
    from_dir = posixpath.dirname(from_document)
    return posixpath.relpath(to_file, from_dir or ".")


# ---- package-level conversion ----

def convert_epub(source: Path, destination: Path, vertical: bool = True,
                 title_jp: str = "", introduction_jp: str = "",
                 authors: Optional[List[str]] = None,
                 toc: Optional[List[dict]] = None,
                 restore_css_from: Optional[Path] = None) -> ConversionReport:
    """Write a Japanese-only copy of `source` to `destination`.

    `toc` is the metadata endpoint's table of contents — entries of
    `{titleJp, titleZh, chapterId?}` in reading order. It is what lets the
    navigation be relabelled in Japanese; without it the text converts fine but
    the contents list keeps the Chinese volume headings.

    `restore_css_from` is the uploaded original of a library volume. The site
    ships those with every stylesheet emptied to nothing, so the publisher's own
    typography — vertical writing included — is copied back from there instead of
    being approximated. Web novels have no stylesheet to restore and get the
    generated one.
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
    # Only bother when the file really was stripped; a stylesheet with content
    # is left exactly as it is.
    restorable = {name: data for name, data in original_css.items()
                  if name in payload and not payload[name].strip() and data.strip()}

    # Where the generated stylesheet will live, so chapters can link to it.
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
                # A restored book already links its own stylesheets.
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
        # `mimetype` must come first and be stored uncompressed.
        if "mimetype" in output:
            archive.writestr(zipfile.ZipInfo("mimetype"), output.pop("mimetype"),
                             compress_type=zipfile.ZIP_STORED)
        for name, data in output.items():
            archive.writestr(name, data)
    temp.replace(destination)
    return report


def _convert_nav(html: str, report: ConversionReport, title_jp: str,
                 toc: List[dict]) -> str:
    """Relabel the contents list in Japanese.

    The nav lists volume headings as `<span>` and chapters as `<a>`, in the same
    order as the metadata table of contents — so entries are matched by position
    rather than by text, which would misfire whenever two chapters share a name.
    """
    if title_jp:
        html = re.sub(r'(<title>).*?(</title>)', lambda m: m.group(1) + _escape(title_jp) + m.group(2),
                      html, count=1, flags=re.S)
        html = re.sub(r'(<h2[^>]*>).*?(</h2>)', lambda m: m.group(1) + _escape(title_jp) + m.group(2),
                      html, count=1, flags=re.S)
    if not toc:
        return html

    pattern = re.compile(r'(<li>\s*)(<span>|<a\b[^>]*>)(.*?)(</span>|</a>)', re.S)
    # A cursor rather than an iterator: scanning with `for entry in entries`
    # consumes everything it steps over, so a single unmatched item would drain
    # the list and silently leave the whole contents page unlabelled.
    position = [0]

    def relabel(match: re.Match) -> str:
        head, open_tag, text, close_tag = match.groups()
        wants_chapter = open_tag.startswith("<a")
        index = position[0]
        while index < len(toc):
            entry = toc[index]
            # A `<span>` is a volume heading (no chapterId); an `<a>` is a chapter.
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
    # navPoints cover chapters only — volume headings have no content document.
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
        # A library volume arrives with the publisher's vertical setup actively
        # reversed, so an existing value has to be overwritten, not just added.
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
        xml = re.sub(r'<spine\b(?![^>]*page-progression-direction)',
                     '<spine page-progression-direction="rtl"', xml, count=1)
    return xml


def _escape(text: str) -> str:
    return (text.replace("&", "&amp;").replace("<", "&lt;")
                .replace(">", "&gt;").replace('"', "&quot;"))


# ---- verification ----

_SPACE = re.compile(r'\s+')


def _comparable(text: str) -> str:
    """Paragraph text reduced to what the two builds can be held to.

    The site pretty-prints the XHTML when it assembles a bilingual volume, which
    puts newlines and indentation *inside* elements — most visibly inside
    `<ruby>`. Once tags are stripped that leaves 「呆\\n     あきれた」 against the
    original's 「呆あきれた」: identical text, different whitespace. Comparing it
    raw failed every volume carrying ruby, so whitespace is dropped on both
    sides. Markup layout is the site's to choose; the characters are the
    contract.
    """
    return _SPACE.sub("", text)


def chapter_paragraphs(path: Path, japanese_only: bool = False) -> Dict[str, List[str]]:
    """Plain-text paragraphs per chapter, for comparing two builds."""
    result: Dict[str, List[str]] = {}
    with zipfile.ZipFile(path) as archive:
        for name in sorted(archive.namelist()):
            if not name.lower().endswith((".xhtml", ".html")) or name.endswith("nav.xhtml"):
                continue
            body_match = _BODY.search(archive.read(name).decode("utf-8"))
            if not body_match:
                continue
            paragraphs = []
            for attrs, inner in _P.findall(body_match.group(2)):
                # Same test the converter uses — `lang="ja"` alone would find
                # nothing in a library volume, whose markup carries no `lang`.
                if japanese_only and not is_japanese_paragraph(attrs):
                    continue
                paragraphs.append(_comparable(_TAGS.sub("", inner)))
            result[name] = paragraphs
    return result


def verify_against_jp(converted: Path, reference: Path,
                      reference_name: str = "the site's own Japanese export"
                      ) -> Tuple[bool, str]:
    """Check a converted file against a Japanese-only build of the same text.

    `reference_name` names what is being compared against, because the two
    catalogues have different references: a web novel has the site's `mode=jp`
    build, a library volume has the publisher's uploaded original.
    """
    got = chapter_paragraphs(converted)
    want = chapter_paragraphs(reference)
    if not want:
        return False, "reference file has no chapters"
    missing = [n for n in want if n not in got]
    if missing:
        return False, f"{len(missing)} chapter(s) missing, e.g. {missing[0]}"
    # Comparing only the reference's chapters would let extra content through
    # unnoticed, so the converted side has to be checked for surplus too.
    extra = [n for n in got if n not in want]
    if extra:
        return False, f"{len(extra)} unexpected chapter(s), e.g. {extra[0]}"
    differing = [n for n in want if got[n] != want[n]]
    if differing:
        name = differing[0]
        return False, (f"{len(differing)} chapter(s) differ, e.g. {name} "
                       f"({len(got[name])} vs {len(want[name])} paragraphs)")
    return True, f"identical to {reference_name} across {len(want)} chapter(s)"
