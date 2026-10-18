"""A post's state as six independent facts, and the one headline the list shows.

Pawchive coverage   full · meta (has_full=false) · none (never listed) · gone (listed, then not)
Fanbox coverage     open · locked (restricted for you) · gone (deleted) · unknown · na (not a
                    Fanbox creator)
Subscription        free · yes (Fanbox opens it to you) · no · unknown (no cookie)
Selection           kept · filtered (with the rule) · creator ignored
Local               derived from the post's files
Downloaded via      per file: pawchive · fanbox · adopted · v1
"""

from dataclasses import dataclass, field


@dataclass
class PostFacts:
    p: str
    f: str
    fee: int
    plan_fee: int | None
    """Highest fee among your current plans for this creator; None without a session."""
    ignored: bool = False
    filtered: str | None = None
    local_done: bool = False
    total: int = 0
    done: int = 0
    failed: int = 0
    deferred: int = 0
    deferred_until: str = ""
    """Earliest retry of a Pawchive 404 among the undone files."""
    stale: str = ""
    """Why a done post may be out of date ("Updated upstream 2026-08-14")."""
    via: list[str] = field(default_factory=list)
    unverified: int = 0


def coverage(p: str, f: str) -> str:
    p_has = p in ("full", "meta")
    f_has = f in ("open", "locked")
    if f in ("unknown", "na"):
        return "ponly" if p_has and f == "na" else ("unknown" if p_has else "local")
    if p_has and f_has:
        return "both"
    if p_has:
        return "ponly"
    if f_has:
        return "fonly"
    return "local"


def subscription(fee: int, plan_fee: int | None, f: str) -> str:
    """Fanbox's own answer for the post wins over your plan list: a cancelled plan drops
    off that list at once, yet its posts stay open until the paid month ends."""
    if fee <= 0:
        return "free"
    if f in ("open", "locked"):
        return "yes" if f == "open" else "no"
    if plan_fee is None:
        return "unknown"
    return "yes" if plan_fee >= fee else "no"


def can_pawchive(facts: PostFacts) -> bool:
    return facts.p == "full"


def can_fanbox(facts: PostFacts) -> bool:
    return facts.f == "open"


def unavailable_reason(facts: PostFacts) -> str:
    """Fanbox's side first: a plan you could take is the one part you can act on, and the
    list clips this line from the right."""
    parts = [
        {
            "open": "",
            "locked": f"Needs a ¥{facts.fee} plan",
            "gone": "Deleted on Fanbox",
            "unknown": "Fanbox not checked",
            "na": "",
        }[facts.f],
        {
            "full": "",
            "meta": "Pawchive metadata only",
            "none": "Not on Pawchive",
            "gone": "Gone from Pawchive",
        }[facts.p],
    ]
    return " · ".join(p for p in parts if p)


def planned_source(facts: PostFacts, preference: str) -> str | None:
    order = ["fanbox", "pawchive"] if preference == "fanbox-first" else ["pawchive", "fanbox"]
    for source in order:
        if source == "pawchive" and can_pawchive(facts):
            return source
        if source == "fanbox" and can_fanbox(facts):
            return source
    return None


VIA_LABEL = {
    "pawchive": "Pawchive",
    "fanbox": "Fanbox",
    "adopted": "Adopted",
    "v1": "v1",
    # Already on disk at the expected path and consistent with the sources.
    "local": "Found on disk",
}


def headline(facts: PostFacts, preference: str = "pawchive-first") -> dict:
    """`{k, t, why, progress}`: the state, its label, one line of reason, 0..1 or None."""
    progress = facts.done / facts.total if facts.total else None
    if facts.ignored:
        return {"k": "ignored", "t": "Ignored", "why": "Creator is ignored", "progress": None}
    if facts.filtered:
        return {"k": "filtered", "t": "Filtered", "why": facts.filtered, "progress": None}
    if facts.local_done:
        why = facts.stale
        if not why and "adopted" in facts.via:
            why = "Adopted · unverified" if facts.unverified else "Adopted · verified"
        return {"k": "done", "t": "Done", "why": why, "progress": None}
    remaining = facts.total - facts.done
    # Every missing file is in its 404 deferral: that is a wait, even for files an earlier
    # run recorded as failed.
    if facts.deferred and facts.deferred >= remaining and not can_fanbox(facts):
        return {
            "k": "wait",
            "t": "Waiting",
            "why": f"Pawchive 404 · retry {facts.deferred_until[5:10]}",
            "progress": progress,
        }
    if facts.failed:
        return {
            "k": "failed",
            "t": f"Failed {facts.failed}",
            "why": f"{facts.done}/{facts.total} · retried next run",
            "progress": progress,
        }
    source = planned_source(facts, preference)
    if source is None:
        return {"k": "na", "t": "Unavailable", "why": unavailable_reason(facts), "progress": None}
    if facts.done:
        return {
            "k": "partial",
            "t": f"Partial {facts.done}/{facts.total}",
            "why": "Next: " + VIA_LABEL[source],
            "progress": progress,
        }
    return {"k": "pending", "t": "Pending", "why": "Next: " + VIA_LABEL[source], "progress": None}
