from dataclasses import dataclass, field
from datetime import datetime
from typing import Dict, List, Optional


# ==================== Core Data Models ====================

@dataclass
class Artist:
    """A tracked creator. `id` is `{service}_{user_id}` and matches kemono's ids."""
    id: str
    service: str
    user_id: str
    name: str
    url: str = ""
    alias: str = ""
    last_date: Optional[str] = None
    timer: Optional[Dict] = None
    ignore: bool = False
    completed: bool = False
    config: Dict = field(default_factory=dict)
    filter: Dict = field(default_factory=dict)

    def display_name(self) -> str:
        return self.alias or self.name


@dataclass
class Post:
    """A single post and its download state."""
    id: str
    user: str
    service: str
    title: str = ""
    content: str = ""
    published: str = ""
    added: str = ""
    edited: Optional[str] = None
    file: Optional[Dict] = None
    attachments: List[Dict] = field(default_factory=list)
    done: bool = False
    failed_files: List[str] = field(default_factory=list)
    # Upstream has only metadata, no file bytes (`has_full: false`); kept out of
    # the normal download/undone flow. Set on sync, cleared by `sync-lost` or a
    # successful download. Default False so an old cache is never silently lost.
    lost: bool = False


@dataclass
class Profile:
    """Creator profile returned by the API. Pawchive does not expose a post
    count, so `updated` is what we diff against to detect changes cheaply."""
    id: str
    name: str = ""
    service: str = ""
    public_id: Optional[str] = None
    indexed: str = ""
    updated: str = ""
    cached_at: str = field(default_factory=lambda: datetime.now().isoformat())


# ==================== Configuration ====================

@dataclass
class Config:
    """Application configuration (global; artists may override a subset)."""
    # Directories
    data_dir: str = "data"
    cache_dir: str = "cache"
    logs_dir: str = "logs"
    download_dir: str = "downloads"

    # Scheduling & filtering
    global_timer: Optional[Dict] = None
    global_filter: Dict = field(default_factory=dict)

    # `links`/`links-all` view filter; empty = show everything. Keys:
    # allowed_domains (keep only these), reviewed_artists (hide, links already
    # gone through), reviewed_before (posts newer than this still surface).
    links_filter: Dict = field(default_factory=dict)

    # Pawchive has migrated domains before (.st -> .pw).
    api_base: str = "https://pawchive.pw/api/v1"
    file_base: str = "https://file.pawchive.pw"

    # Proxies come from the environment (HTTP_PROXY / ...), not from here.
    retry_delay: int = 5
    request_timeout: int = 30

    # Attempts per request; 0 = forever. API requests are unlimited (losing a
    # list response truncates a creator). Downloads are bounded, because
    # Pawchive answers 503/404 for files it has not materialised and an
    # unbounded wait stalls the queue; a give-up leaves the post undone, so the
    # data still converges to 100% across runs.
    max_retries: int = 0
    download_max_retries: int = 5

    # A 404 is permanent; retried only enough to rule out a bad edge node.
    not_found_max_retries: int = 3

    # `updated` is a bulk-import batch timestamp and posts get inserted after
    # it, so trusting it can skip new posts. `page_workers` is speed only.
    trust_updated_timestamp: bool = False
    page_workers: int = 4

    user_agent: str = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) "
        "Gecko/20100101 Firefox/135.0"
    )

    # Total concurrency is artists x posts x files.
    max_concurrent_artists: int = 3
    max_concurrent_posts: int = 5
    max_concurrent_files: int = 10

    notify: bool = False

    # Path templates. `{group}` mirrors the `data/artists/` tree, so grouping is
    # just a variable -- drop it and downloads go flat again. Creator before
    # service, or each group folder grows its own `fanbox/`+`patreon/` pair.
    # Keep `{id}`: it is how `relayout-artists` recognises a folder whose title
    # has changed upstream. `{title:.60}` caps a name shorter than the
    # filesystem limit sanitize_component already enforces.
    date_format: str = "%Y.%m.%d"
    artist_folder_template: str = "{group}/{alias}/{service}"
    post_folder_template: str = "[{published}][{id}] {title}"
    file_template: str = "{idx}"

    # Download behaviour
    save_content: bool = True
    save_empty_posts: bool = False
    rename_images_only: bool = True
    image_extensions: set = field(
        default_factory=lambda: {'.jpe', '.jpg', '.jpeg', '.png', '.gif', '.webp'}
    )


# ==================== History ====================

@dataclass
class HistoryRecord:
    command: str
    timestamp: str = field(default_factory=lambda: datetime.now().isoformat())
    success: bool = True
    artist_id: Optional[str] = None
    params: Dict = field(default_factory=dict)
    note: str = ""


# ==================== Download Results ====================

@dataclass
class DownloadResult:
    """Outcome of downloading one artist."""
    artist_id: str
    success: bool = True
    posts_downloaded: int = 0
    posts_failed: int = 0


# ==================== Scheduler Models ====================

class TaskType:
    MANUAL = "manual"
    SCHEDULED = "scheduled"
    SYNC = "sync"        # refresh the post list only, no files


class TaskStatus:
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


@dataclass
class DownloadTask:
    artist_id: str
    from_date: Optional[str] = None
    until_date: Optional[str] = None
    deep: bool = False               # SYNC only: also re-flag edited posts
    # Download subsets. `lost` forces a retry of posts upstream has no files for;
    # `pending`/`failed` split the undone set into never-tried and previously
    # failed. None or both of the latter means the whole undone set.
    lost: bool = False
    pending: bool = False
    failed: bool = False
    recover_lost: bool = False       # SYNC only: un-mark posts the server has restored
    task_type: str = TaskType.MANUAL
    status: str = TaskStatus.QUEUED
    created_at: datetime = field(default_factory=datetime.now)
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    error: Optional[str] = None
    note: str = ""                   # one-line outcome, shown by `tasks`

    def __eq__(self, other):
        return isinstance(other, DownloadTask) and (
            (self.artist_id, self.from_date, self.until_date)
            == (other.artist_id, other.from_date, other.until_date)
        )

    def __hash__(self):
        return hash((self.artist_id, self.from_date, self.until_date))


# ==================== External Links ====================

@dataclass
class ExternalLink:
    """A URL found in a post's content/body."""
    url: str
    domain: str
    protocol: str
    post_id: str
    post_title: str
    post_published: str
    post_edited: Optional[str]
    artist_id: str


# ==================== Migration (template re-layout) ====================

class MigrationType:
    POST = "post"
    FILE = "file"
    ARTIST = "artist"   # whole creator folder, moved to match the templates


@dataclass
class MigrationConfig:
    """A snapshot of the path templates used to compute old/new locations."""
    download_dir: str
    artist_folder_template: str
    post_folder_template: str
    file_template: str
    date_format: str
    rename_images_only: bool
    image_extensions: set


@dataclass
class MigrationPlan:
    migration_type: str
    total_items: int = 0
    mappings: List[tuple] = field(default_factory=list)   # (old, new, item_id)
    conflicts: List[tuple] = field(default_factory=list)  # (path, [ids])
    skipped: List[tuple] = field(default_factory=list)    # (item_id, reason)

    @property
    def success_count(self) -> int:
        return len(self.mappings)

    @staticmethod
    def empty(migration_type: str) -> 'MigrationPlan':
        return MigrationPlan(migration_type=migration_type)


@dataclass
class MigrationResult:
    migration_type: str
    total: int
    success: int = 0
    failed: List[tuple] = field(default_factory=list)  # (old, new, item_id, error)
