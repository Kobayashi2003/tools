"""Turn raw messages into recommendations.

Unlike the old sharing channel, this one has no house style to guess at: every
post is written by one bot to one shape, and anything else in the channel is
chatter. So the parse is a labelled-field read rather than a heuristic --

    Sharing a good one
    Recommender: Anon
    Type: Light Novel LN ラノベ ライトノベル
    Series title: 賢者の弟子を名乗る賢者
    Volumes: 20-23
    Job: `tp_023e0cbfad`

-- with two things it still has to be careful about. A field's value can run
over several lines (`Book titles:` is a filename per line), so a line is a new
field only when it opens with a label this format actually uses. And the one
field that matters, `Job:`, is what makes a message a recommendation at all:
without it there is nothing to press and nothing to download.
"""

import re
from typing import List

from .models import FileEntry, Rec, snowflake_time

# 0 default, 19 reply. The rest are joins, pins, boosts -- channel furniture.
CONTENT_TYPES = {0, 19}

# The labels the bot writes. A line starting with any of these opens a field;
# every other line continues the one above it.
LABELS = {
    "recommender": "recommender",
    "type": "type",
    "series title": "title",
    "book titles": "titles",
    "book title": "titles",
    "title": "title",
    "volumes": "volumes",
    "volume": "volumes",
    "additional description": "description",
    "description": "description",
    "job": "job",
}
LABEL_RE = re.compile(r"^\s*([A-Za-z][A-Za-z ]{1,28}?)\s*:\s*(.*)$")
MENTION_RE = re.compile(r"^<@!?(\d+)>$")
JOB_RE = re.compile(r"[`'\"]?([A-Za-z0-9_]{4,40})[`'\"]?")

# Type is written as an English name followed by its Japanese equivalents, and
# sometimes an initialism: `Light Novel LN ラノベ ライトノベル`. The English head
# is the label worth showing; the rest is the same word again.
CJK_RE = re.compile(r"[぀-ヿ㐀-䶵一-鿿ａ-ｚＡ-Ｚ]")


def _fold_kind(text: str) -> str:
    """`Light Novel LN ラノベ ライトノベル` -> `Light Novel`."""
    head = CJK_RE.split(text or "", 1)[0].strip(" 　/|-–—")
    if not head:
        return (text or "").strip()
    words = head.split()
    # Drop a trailing initialism -- `LN` after `Light Novel` -- but never when
    # it is the only thing there, because `VN` on its own is the whole label.
    if len(words) > 1 and words[-1].isupper() and len(words[-1]) <= 3:
        words = words[:-1]
    head = " ".join(words)
    # `subtitles` and `Subtitles` are one kind; the bot is not consistent.
    return head[:1].upper() + head[1:] if head else text.strip()


def kind_key(text: str) -> str:
    """`Non-fiction`, `Non fiction` and `Nonfiction` are one kind."""
    return re.sub(r"[^0-9a-z]", "", (text or "").casefold())


def _fields(content: str) -> dict:
    """Read the labelled block. Values keep their line breaks."""
    out, current = {}, None
    blurb: List[str] = []
    for raw in (content or "").replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = raw.rstrip()
        match = LABEL_RE.match(line)
        key = LABELS.get(match.group(1).strip().casefold()) if match else None
        if key:
            current = key
            out[key] = match.group(2).strip()
            continue
        if current is None:
            # Before the first label: the bot's one-line aside.
            if line.strip():
                blurb.append(line.strip())
            continue
        if line.strip():
            out[current] = (out[current] + "\n" + line.strip()).strip()
    out["blurb"] = " ".join(blurb)
    return out


def _covers(raw: dict) -> List[FileEntry]:
    attachments = [FileEntry.from_attachment(a) for a in raw.get("attachments") or []]
    return [a for a in attachments if a.is_image]


def _button(raw: dict) -> str:
    """The custom_id of the message's own button, which says how it is hosted."""
    for row in raw.get("components") or []:
        for item in row.get("components") or [row]:
            if item.get("type") == 2 and item.get("custom_id"):
                return str(item["custom_id"])
    return ""


def build_rec(raw: dict) -> Rec:
    author = raw.get("author") or {}
    got = _fields(raw.get("content") or "")

    job = ""
    if got.get("job"):
        found = JOB_RE.search(got["job"])
        job = found.group(1) if found else ""

    who = (got.get("recommender") or "").strip()
    who_id = ""
    mention = MENTION_RE.match(who)
    if mention:
        who_id = mention.group(1)

    titles = [t.strip() for t in (got.get("titles") or "").split("\n") if t.strip()]
    title = (got.get("title") or "").strip()
    if not title and titles:
        # A post that lists filenames instead of a series: the first one names
        # it well enough to read and to search by, and the rest are on the card.
        title = titles[0]

    kind = (got.get("type") or "").strip()
    return Rec(
        message_id=str(raw.get("id", "")),
        author=author.get("global_name") or author.get("username", "") or "unknown",
        author_id=str(author.get("id", "")),
        timestamp=snowflake_time(str(raw["id"])),
        blurb=got.get("blurb", ""),
        recommender=who,
        recommender_id=who_id,
        kind=kind,
        label=_fold_kind(kind),
        title=title,
        titles=titles,
        volumes=(got.get("volumes") or "").strip(),
        description=(got.get("description") or "").strip(),
        job=job,
        custom_id=_button(raw),
        covers=_covers(raw),
        reactions=sum(int(r.get("count") or 0) for r in raw.get("reactions") or []),
    )


def why_dropped(messages: List[dict]) -> dict:
    """Count what never became a recommendation, and for which reason.

    A recommendations channel is mostly recommendations, so a poor yield means
    something is being misread rather than that the channel is quiet -- and the
    difference is worth one pass over the cache to find out.
    """
    tally = {"total": len(messages), "system": 0, "human": 0, "no_job": 0, "kept": 0}
    for raw in messages:
        if raw.get("type", 0) not in CONTENT_TYPES:
            tally["system"] += 1
        elif not (raw.get("author") or {}).get("bot"):
            tally["human"] += 1
        elif not build_rec(raw).has_payload:
            tally["no_job"] += 1
        else:
            tally["kept"] += 1
    return tally


def _settle_labels(recs: List[Rec]) -> None:
    """Spell each kind the way the channel spells it most often.

    The bot writes the type from a fixed menu, so folding is nearly always
    exact; this only settles the odd `subtitles` against `Subtitles`.
    """
    spellings = {}
    for rec in recs:
        if rec.label:
            spellings.setdefault(kind_key(rec.label), {}).setdefault(rec.label, 0)
            spellings[kind_key(rec.label)][rec.label] += 1
    for rec in recs:
        table = spellings.get(kind_key(rec.label))
        if table:
            rec.label = max(table, key=table.get)


def build_posts(messages: List[dict], config=None) -> List[Rec]:
    """Oldest first in, oldest first out. Chatter and stickies are dropped."""
    recs: List[Rec] = []
    for raw in sorted(messages, key=lambda m: int(m["id"])):
        if raw.get("type", 0) not in CONTENT_TYPES:
            continue
        # Who posted it is not the question -- whether it carries a job is. The
        # channel's own bot posts stickies too, and members talk in it.
        rec = build_rec(raw)
        if rec.has_payload:
            recs.append(rec)
    _settle_labels(recs)
    return recs


def apply_names(recs: List[Rec], names: dict) -> None:
    """Put resolved display names on the mentions, in place.

    The bot posts mentions with pings suppressed, so Discord sends the message
    with an empty `mentions` array and the id is all there is. Names are looked
    up separately, over the gateway, and folded in here.
    """
    for rec in recs:
        if rec.recommender_id:
            name = names.get(rec.recommender_id)
            rec.recommender = name or rec.recommender
