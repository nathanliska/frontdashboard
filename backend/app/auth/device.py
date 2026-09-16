"""A coarse "browser on platform" label for a session row, and nothing finer (ADR-003)."""

from fastapi.datastructures import Headers

# Order matters: every Chromium fork keeps the Chrome token, and every WebKit browser the Safari one.
# "Edg" also covers the EdgA and EdgiOS tokens of mobile Edge.
_BROWSERS = (
    ("Edg", "Edge"),
    ("OPR/", "Opera"),
    ("OPX/", "Opera"),
    ("SamsungBrowser/", "Samsung Internet"),
    ("Firefox/", "Firefox"),
    ("FxiOS/", "Firefox"),
    ("Chrome/", "Chrome"),
    ("CriOS/", "Chrome"),
    ("Safari/", "Safari"),
)
# A desktop-mode iPad sends the Mac string and reads as Mac (FDR-001); that is accepted.
_PLATFORMS = (
    ("iPhone", "iPhone"),
    ("iPad", "iPad"),
    ("Android", "Android"),
    ("Windows", "Windows"),
    ("CrOS", "Chrome OS"),
    ("Macintosh", "Mac"),
    ("Linux", "Linux"),
)


def device_label(headers: Headers) -> str | None:
    """Name the signing-in browser the way a person would, or None when nothing recognisable was sent."""
    agent = headers.get("user-agent", "")
    browser = next((name for token, name in _BROWSERS if token in agent), None)
    platform = next((name for token, name in _PLATFORMS if token in agent), None)
    if browser and platform:
        return f"{browser} on {platform}"
    return browser or platform
