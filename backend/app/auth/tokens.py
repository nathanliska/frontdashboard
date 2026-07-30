"""Opaque bearer tokens.

Every credential this app hands out is 256 bits of urandom stored only as its SHA-256 — nothing
signs anything, so there is no `SECRET_KEY` (ADR-003). Plain SHA-256 suits full-entropy values
with nothing to brute-force; passwords go through `app/auth/hashing.py` (Argon2id) instead.
"""

import hashlib
import os


def create_opaque_token() -> tuple[str, str]:
    """Mint an opaque token as (raw, sha256_hash).

    The raw value goes in the cookie or the link; only the hash is stored, so a database
    disclosure yields nothing usable.
    """
    raw = os.urandom(32).hex()
    return raw, _hash_raw(raw)


def hash_token(raw: str) -> str:
    return _hash_raw(raw)


def _hash_raw(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()
