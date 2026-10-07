"""Validated settings and task requests shared by the API and worker."""

import re
from typing import Literal
from urllib.parse import unquote, urlparse

from pydantic import BaseModel, Field, field_validator, model_validator

SITE = "https://n.novelia.cc"
CATEGORIES = {0: "All library novels", 1: "Light novels", 2: "Light literature",
              3: "Literature", 4: "Nonfiction", 5: "R18 male", 6: "R18 female"}
LEVELS = {"一般向": 1, "轻文学": 2, "严肃向": 3, "非小说": 4, "成人向": 5, "成人向女": 6}
PROVIDERS = ("kakuyomu", "syosetu", "novelup", "hameln", "pixiv", "alphapolis")


CLOCK = r"^([01]\d|2[0-3]):[0-5]\d$"
# Pacing and retry behaviour. Unlike content settings, these follow the current settings
# whenever a task starts or resumes, so a throttled task can be slowed down without recreating it.
PACING_FIELDS = ("request_delay", "request_jitter", "adaptive_delay", "max_delay", "connect_timeout", "timeout",
                 "retries", "backoff_base", "backoff_max", "rate_limit_patience", "rate_limit_pause",
                 "max_pauses", "retry_rounds", "retry_round_delay", "rest_every", "rest_seconds",
                 "active_hours", "active_start", "active_end")


class Settings(BaseModel):
    # Pacing
    request_delay: float = Field(default=1.0, ge=0.2, le=60)
    request_jitter: int = Field(default=30, ge=0, le=100)  # percent
    adaptive_delay: bool = True
    max_delay: float = Field(default=30, ge=1, le=600)
    rest_every: int = Field(default=0, ge=0, le=10000)  # downloads; 0 disables rests
    rest_seconds: float = Field(default=120, ge=1, le=3600)
    connect_timeout: int = Field(default=15, ge=3, le=120)
    timeout: int = Field(default=90, ge=5, le=600)
    # Failures and rate limits
    retries: int = Field(default=3, ge=1, le=10)
    backoff_base: float = Field(default=5, ge=1, le=600)
    backoff_max: float = Field(default=300, ge=5, le=3600)
    rate_limit_patience: float = Field(default=10, ge=0, le=240)  # minutes
    rate_limit_pause: float = Field(default=30, ge=1, le=1440)  # minutes
    max_pauses: int = Field(default=6, ge=0, le=100)
    retry_rounds: int = Field(default=2, ge=0, le=10)
    retry_round_delay: float = Field(default=60, ge=0, le=3600)
    # Active hours (server local time)
    active_hours: bool = False
    active_start: str = Field(default="01:00", pattern=CLOCK)
    active_end: str = Field(default="07:00", pattern=CLOCK)
    # Content
    page_size: int = Field(default=24, ge=1, le=100)
    source_mode: Literal["jp-zh", "zh-jp"] = "jp-zh"
    translations: list[Literal["sakura", "gpt", "youdao", "baidu"]] = Field(
        default_factory=lambda: ["sakura", "gpt", "youdao"], min_length=1)
    translations_mode: Literal["priority", "parallel"] = "priority"
    download_chinese_uploads: bool = True
    auto_convert: bool = False
    vertical: bool = True
    verify: bool = True
    incremental_enabled: bool = False
    interval_hours: float = Field(default=24, ge=0.25, le=8760)

    @field_validator("translations")
    @classmethod
    def unique_translations(cls, value):
        return list(dict.fromkeys(value))

    @model_validator(mode="after")
    def consistent_limits(self):
        if self.backoff_max < self.backoff_base:
            raise ValueError("The backoff cap must be at least the first backoff.")
        if self.active_hours and self.active_start == self.active_end:
            raise ValueError("Active hours need different start and end times.")
        return self


def normalize_key(value: str) -> str:
    value = value.strip()
    if value.startswith(("http://", "https://")):
        parsed = urlparse(value)
        if parsed.scheme != "https" or parsed.hostname != "n.novelia.cc" or parsed.port not in (None, 443):
            raise ValueError("Use an https://n.novelia.cc work URL.")
        value = unquote(parsed.path).strip("/").removeprefix("novel/")
    if re.fullmatch(r"wenku/[0-9a-fA-F]{24}", value):
        return value.lower()
    if re.fullmatch(rf"(?:{'|'.join(PROVIDERS)})/[A-Za-z0-9_-]{{1,150}}", value):
        return value
    raise ValueError("Use wenku/<24-character ID>, provider/<ID>, or a Novelia work URL.")


def parse_range(value: str, count: int) -> list[int]:
    """Return one-based indexes; reject malformed or descending ranges."""
    if not value.strip():
        return list(range(1, count + 1))
    picked = set()
    for part in value.split(","):
        match = re.fullmatch(r"\s*([1-9]\d*)(?:\s*-\s*([1-9]\d*))?\s*", part)
        if not match:
            raise ValueError("Volume range must look like 1,3,5-8.")
        start, end = int(match[1]), int(match[2] or match[1])
        if end < start:
            raise ValueError("Volume range must be ascending.")
        picked.update(range(start, min(end, count) + 1))
    return sorted(picked)


class JobRequest(BaseModel):
    kind: Literal["full", "range", "incremental", "manual", "convert"]
    category: int = Field(default=1, ge=0, le=6)
    start_page: int = Field(default=1, ge=1, le=100000)
    end_page: int | None = Field(default=None, ge=1, le=100000)
    query: str = Field(default="", max_length=300)
    keys: list[str] = Field(default_factory=list, max_length=1000)
    file_ids: list[int] = Field(default_factory=list, max_length=10000)
    volumes: str = Field(default="", max_length=500)
    download: bool = True
    force: bool = False

    @model_validator(mode="after")
    def validate_scope(self):
        self.query = self.query.strip()
        self.keys = list(dict.fromkeys(normalize_key(v) for v in self.keys))
        if self.volumes:
            parse_range(self.volumes, 0)
        if self.kind in ("full", "incremental"):
            self.category, self.start_page, self.end_page, self.query = 1, 1, None, ""
            if self.volumes:
                raise ValueError("Full and incremental scans include every volume.")
        if self.kind == "range" and (self.end_page is None or self.end_page < self.start_page):
            raise ValueError("Set an end page at or after the start page.")
        if self.kind == "manual" and not self.keys:
            raise ValueError("Enter at least one work ID or URL.")
        if any(v < 1 for v in self.file_ids):
            raise ValueError("File IDs must be positive.")
        return self


class RetryRequest(BaseModel):
    targets: list[str] = Field(default_factory=list, max_length=10000)
