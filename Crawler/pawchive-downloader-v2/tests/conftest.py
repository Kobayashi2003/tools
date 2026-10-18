from pathlib import Path

import pytest

from app.engine.context import Context


@pytest.fixture
def ctx(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Context:
    for name in ("FANBOX_SESSID", "PAWCHIVE_DOWNLOAD_DIR"):
        monkeypatch.delenv(name, raising=False)
    (tmp_path / "data").mkdir()
    c = Context(tmp_path / "data")
    c.store.save({"download_dir": str(tmp_path / "downloads")})
    c.reload_settings()
    return c
