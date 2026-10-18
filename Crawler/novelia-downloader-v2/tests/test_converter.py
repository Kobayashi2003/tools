import zipfile

from app.converter import convert_epub, verify_against_jp
from tests.conftest import epub


def test_self_closing_spacers_match_original_and_existing_ltr_is_replaced(tmp_path):
    source = epub(tmp_path / "source.epub")
    reference = epub(tmp_path / "reference.epub", False)
    with zipfile.ZipFile(source) as z:
        payload = {n: z.read(n) for n in z.namelist()}
    payload["OPS/book.opf"] = payload["OPS/book.opf"].replace(
        b"<spine>", b'<spine page-progression-direction="ltr">'
    )
    with zipfile.ZipFile(source, "w") as z:
        for name, data in payload.items():
            z.writestr(name, data)
    output = tmp_path / "out.epub"
    convert_epub(source, output)
    assert verify_against_jp(output, reference)[0]
    with zipfile.ZipFile(output) as z:
        assert b'page-progression-direction="rtl"' in z.read("OPS/book.opf")
        assert (
            z.infolist()[0].filename == "mimetype"
            and z.infolist()[0].compress_type == zipfile.ZIP_STORED
        )


def with_chapter(path, body):
    with zipfile.ZipFile(path) as z:
        payload = {n: z.read(n) for n in z.namelist()}
    payload["OPS/chapter.xhtml"] = (
        f"<html><head><title>T</title></head><body>{body}</body></html>".encode()
    )
    with zipfile.ZipFile(path, "w") as z:
        for name, data in payload.items():
            z.writestr(name, data)
    return path


def test_empty_translations_comments_and_entities_still_verify(tmp_path):
    hidden = "<!-- <p>表示されない注記</p> -->"
    source = with_chapter(
        epub(tmp_path / "source.epub"),
        '<p style="opacity:0.4">http://example.jp/</p><p></p>'  # untranslatable: empty translation
        "<p><br/></p>"  # the book's own blank line
        f'<p style="opacity:0.4">著作権&#xa0;&#169;</p><p>版权</p>{hidden}',
    )
    reference = with_chapter(
        epub(tmp_path / "reference.epub", False),
        f"<p>http://example.jp/</p><p><br/></p><p>著作権&#160;©</p>{hidden.replace('<p>', '<p class="c">')}",
    )
    output = tmp_path / "out.epub"
    report = convert_epub(source, output)
    assert report.kept_blank == 1  # the empty translation is gone, the blank line stays
    assert verify_against_jp(output, reference)[0]


def chinese_body(path):
    with zipfile.ZipFile(path) as z:
        chapter, opf = z.read("OPS/chapter.xhtml").decode(), z.read("OPS/book.opf").decode()
    return chapter.split("<body>")[1].split("</body>")[0], opf


def test_chinese_edition_keeps_translations_and_untranslated_lines(tmp_path):
    body = (
        '<h2>第一章</h2><h2>第一章　はじまり</h2><p class="c">挿絵</p>'
        '<p style="opacity:0.4">こんにちは</p><p>你好</p>'
        '<p style="opacity:0.4">http://example.jp/</p><p></p>'
        "<p><br/></p>"
        '<p style="opacity:0.4">さようなら</p>'
    )
    source = with_chapter(epub(tmp_path / "source.epub"), body)
    report = convert_epub(source, tmp_path / "zh.epub", chinese=True)
    text, opf = chinese_body(tmp_path / "zh.epub")
    assert text == (
        '<h2>第一章</h2><p class="c">挿絵</p><p>你好</p><p>http://example.jp/</p>'
        "<p><br/></p><p>さようなら</p>"
    )
    assert (report.kept_zh, report.untranslated) == (1, 2)
    assert "<dc:language>zh</dc:language>" in opf and "rtl" not in opf

    flipped = '<p>你好</p><p style="opacity:0.4">こんにちは</p><p>再见</p><p style="opacity:0.4">さようなら</p>'
    source = with_chapter(epub(tmp_path / "zh-jp.epub"), flipped)
    convert_epub(source, tmp_path / "zh2.epub", chinese=True, translation_first=True)
    assert chinese_body(tmp_path / "zh2.epub")[0] == "<p>你好</p><p>再见</p>"
