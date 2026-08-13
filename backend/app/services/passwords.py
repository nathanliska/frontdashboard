"""Refuse the passwords attackers actually spray.

Length alone is a weak policy: `password123` clears an 8-character minimum and sits 469th in the
NCSC's most-used list. The data file holds the 10,000 most-used entries from that list that are at
least as long as the minimum — shorter ones are refused before they could reach this check.

It stays in the source's frequency order, so the cut is at a rank rather than an alphabetical
accident, and extending it later means taking more from the same ranked source.

Deliberately not a complexity rule. Character-class requirements push people toward predictable
substitutions that these same lists already contain, which is why NIST retired them in favour of
screening against known-compromised passwords.
"""

import pathlib

from fastapi import HTTPException, status

_LIST_PATH = pathlib.Path(__file__).resolve().parents[1] / "data" / "common_passwords.txt"

# Read once at import — the check sits on the request path for registration, reset and change, and
# the set is small enough (~10k short strings) that the memory is not worth a lazy load.
COMMON_PASSWORDS: frozenset[str] = frozenset(line.strip() for line in _LIST_PATH.read_text(encoding="utf-8").splitlines() if line.strip())

_TOO_COMMON_DETAIL = "That password appears on public lists of breached passwords. Please choose a different one."


def assert_password_not_common(password: str) -> None:
    """Reject a password that appears on the breached-password list.

    The stripped form is checked too, so a trailing space cannot smuggle a listed password past a
    comparison that is otherwise exact.

    Raises:
        HTTPException: 422 when the password is listed.
    """
    candidate = password.lower()
    if candidate in COMMON_PASSWORDS or candidate.strip() in COMMON_PASSWORDS:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=_TOO_COMMON_DETAIL)
