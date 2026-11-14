"""Applies `NOVELIA_PROXY` (a URL, or `none` for direct) to a requests session."""

import requests


def apply_to_session(session: requests.Session, own: str) -> None:
    """Apply the app's own setting. Left empty, requests finds HTTPS_PROXY /
    HTTP_PROXY, else the system proxy, itself, and still sends the hosts in
    NO_PROXY and the Windows bypass list direct, which a pinned proxy would not."""
    own = own.strip()
    if own.lower() == "none":
        session.trust_env = False
    elif own:
        session.proxies = {"http": own, "https": own}
