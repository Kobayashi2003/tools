"""The one proxy every channel of this app uses: httpx and the browser alike.

`X_IMAGE_PROXY` (a URL, or `none` for direct), else HTTPS_PROXY / HTTP_PROXY, else
the proxy Windows is set to use (which Clash switches), else none.
"""

import sys
import urllib.parse
import urllib.request

# Reached directly whatever the proxy.
BYPASS = (
    "localhost",
    "127.0.0.0/8",
    "::1",
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
)


def resolve_proxy(own: str) -> str | None:
    """The proxy URL to use, or None to connect directly."""
    own = own.strip()
    if own:
        return None if own.lower() == "none" else own
    # Not getproxies(): it reads no further than the environment once NO_PROXY
    # alone is set there, and would miss the system proxy.
    found = urllib.request.getproxies_environment()
    proxy = found.get("https") or found.get("http") or windows_proxy()
    if proxy and "://" not in proxy:
        proxy = "http://" + proxy
    return proxy or None


def windows_proxy() -> str | None:
    """The proxy Windows is set to use, read afresh so Clash's switch applies."""
    if sys.platform != "win32":
        return None
    import winreg

    path = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings"
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, path) as key:
            if not winreg.QueryValueEx(key, "ProxyEnable")[0]:
                return None
            server = str(winreg.QueryValueEx(key, "ProxyServer")[0])
    except OSError:
        return None
    # Either "host:port" for every scheme, or "http=host:port;https=host:port;…".
    if "=" not in server:
        return server or None
    by_scheme = dict(part.split("=", 1) for part in server.split(";") if "=" in part)
    return by_scheme.get("https") or by_scheme.get("http")


def chromium_args(proxy: str | None) -> list[str]:
    """Chrome / Edge flags. A browser left alone reads only the system proxy,
    never HTTPS_PROXY."""
    if not proxy:
        return ["--no-proxy-server"]
    return [f"--proxy-server={proxy}", "--proxy-bypass-list=<local>;" + ";".join(BYPASS)]
