import zipfile

from app.converter import convert_epub, verify_against_jp
from tests.conftest import epub


def test_self_closing_spacers_match_original_and_existing_ltr_is_replaced(tmp_path):
    source = epub(tmp_path / "source.epub")
    reference = epub(tmp_path / "reference.epub", False)
    with zipfile.ZipFile(source) as z:
        payload = {n:z.read(n) for n in z.namelist()}
    payload["OPS/book.opf"] = payload["OPS/book.opf"].replace(b"<spine>", b'<spine page-progression-direction="ltr">')
    with zipfile.ZipFile(source,"w") as z:
        for name, data in payload.items():
            z.writestr(name,data)
    output = tmp_path / "out.epub"
    convert_epub(source,output)
    assert verify_against_jp(output,reference)[0]
    with zipfile.ZipFile(output) as z:
        assert b'page-progression-direction="rtl"' in z.read("OPS/book.opf")
        assert z.infolist()[0].filename == "mimetype" and z.infolist()[0].compress_type == zipfile.ZIP_STORED
