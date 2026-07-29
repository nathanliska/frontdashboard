"""Opaque bearer tokens.

Every credential this app hands out — the session cookie, email verification, password reset,
dashboard invites — is 256 bits of urandom stored only as its SHA-256. Nothing here is a JWT, and
nothing signs anything, so the app has no `SECRET_KEY` (ADR-003).

Plain SHA-256 rather than a password hash is right for all of them: these are full-entropy
random values, so there is nothing to brute-force and no salt to need. It is emphatically *not*
right for passwords — those go through `app/auth/hashing.py` (Argon2id).
"""

import hashlib
import os


def create_opaque_token() -> tuple[str, str]:
    """Return (raw_token, sha256_hash). The raw token goes in the cookie or the link; only the
    hash is stored, so a database disclosure yields nothing usable."""
    raw = os.urandom(32).hex()
    return raw, _hash_raw(raw)


def hash_token(raw: str) -> str:
    return _hash_raw(raw)


def _hash_raw(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()
