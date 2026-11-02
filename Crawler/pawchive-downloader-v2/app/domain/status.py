"""A post's state as six independent facts, and the one headline the list shows.

Pawchive coverage   full · meta (has_full=false) · none (never listed) · gone (listed, then not)
Fanbox coverage     open · locked (restricted for you) · gone (deleted) · unknown · na (not a
                    Fanbox creator)
Subscription        free · yes (Fanbox opens it to you) · no · unknown (no cookie)
Selection           kept · filtered (with the rule) · creator ignored
Local               derived from the post's files
Downloaded via      per file: pawchive · fanbox · adopted · local

"Fanbox" in these keys means the creator's own site: Fanbox for a Fanbox creator, Patreon
for a Patreon one (`SITES`). Both are read the same way and stored in the same columns;
only the labels the UI shows differ (`site_label`).
"""

from dataclasses import dataclass, field

# Services whose creators have their own site this tool reads, with its label and currency.
SITES = {"fanbox": ("Fanbox", "¥"), "patreon": ("Patreon", "$")}


def has_site(service: str) -> bool:
    return service in SITES


def site_label(service: str) -> str:
    return SITES.get(service, ("Fanbox", "¥"))[0]


def site_currency(service: str) -> str:
    return SITES.get(service, ("Fanbox", "¥"))[1]


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
    missing: int = 0
    """Undone files Pawchive answered 404 for: only a download by hand asks again."""
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


def unavailable_reason(facts: PostFacts, service: str = "fanbox") -> str:
    """The creator's own site first: a plan you could take is the one part you can act on,
    and the list clips this line from the right."""
    site, money = site_label(service), site_currency(service)
    locked = (
        f"Needs a {money}{facts.fee} plan"
        if service != "patreon" or facts.fee > 1
        else "Needs a paid tier"
    )
    parts = [
        {
            "open": "",
            "locked": locked,
            "gone": f"Deleted on {site}",
            "unknown": f"{site} not checked",
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


def source_order(preference: str) -> list[str]:
    return ["pawchive", "fanbox"] if preference == "pawchive-first" else ["fanbox", "pawchive"]


def planned_source(facts: PostFacts, preference: str) -> str | None:
    for source in source_order(preference):
        if source == "pawchive" and can_pawchive(facts):
            return source
        if source == "fanbox" and can_fanbox(facts):
            return source
    return None


VIA_LABEL = {
    "pawchive": "Pawchive",
    "fanbox": "Fanbox",
    # Already on disk at the expected path and consistent with the sources.
    "local": "Found on disk",
}


def shown_via(via: str) -> str:
    """Adopted files are Fanbox's own, saved by the browser extension, so they are shown as
    Fanbox; only the "Adopted · unverified" check still tells them apart."""
    return "fanbox" if via == "adopted" else via


def headline(facts: PostFacts, preference: str = "fanbox-first", service: str = "fanbox") -> dict:
    """`{k, t, why, progress}`: the state, its label, one line of reason, 0..1 or None."""
    labels = {**VIA_LABEL, "fanbox": site_label(service)}
    progress = facts.done / facts.total if facts.total else None
    if facts.ignored:
        return {"k": "ignored", "t": "Ignored", "why": "Creator is ignored", "progress": None}
    if facts.filtered:
        return {"k": "filtered", "t": "Filtered", "why": facts.filtered, "progress": None}
    if facts.local_done:
        why = facts.stale
        if not why and "adopted" in facts.via and facts.unverified:
            why = "Adopted · unverified"
        return {"k": "done", "t": "Done", "why": why, "progress": None}
    remaining = facts.total - facts.done
    # Every missing file 404ed on Pawchive: failed, and no run retries it by itself.
    if facts.missing and facts.missing >= remaining and not can_fanbox(facts):
        return {
            "k": "failed",
            "t": f"Failed {remaining}",
            "why": f"{facts.done}/{facts.total} · Pawchive 404, not retried",
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
        why = unavailable_reason(facts, service)
        return {"k": "na", "t": "Unavailable", "why": why, "progress": None}
    if facts.done:
        return {
            "k": "partial",
            "t": f"Partial {facts.done}/{facts.total}",
            "why": "Next: " + labels[source],
            "progress": progress,
        }
    return {"k": "pending", "t": "Pending", "why": "Next: " + labels[source], "progress": None}
