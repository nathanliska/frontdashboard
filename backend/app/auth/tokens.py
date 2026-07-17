import hashlib
import os
import uuid
from datetime import UTC, datetime, timedelta

import jwt

from app.config import settings

_ALGORITHM = "HS256"


def create_access_token(user_id: uuid.UUID, email: str, session_id: uuid.UUID) -> str:
    expire = datetime.now(UTC) + timedelta(minutes=settings.access_token_expire_minutes)
    payload = {
        "sub": str(user_id),
        "email": email,
        "sid": str(session_id),
        "exp": expire,
        "iat": datetime.now(UTC),
    }
    return jwt.encode(payload, settings.secret_key, algorithm=_ALGORITHM)


def decode_access_token(token: str) -> dict:
    """Decode and verify a JWT access token. Raises jwt.PyJWTError on failure."""
    return jwt.decode(token, settings.secret_key, algorithms=[_ALGORITHM])


def create_opaque_token() -> tuple[str, str]:
    """Return (raw_token, sha256_hash). The raw token goes in the cookie; hash is stored in DB."""
    raw = os.urandom(32).hex()
    return raw, _hash_raw(raw)


def hash_token(raw: str) -> str:
    return _hash_raw(raw)


def _hash_raw(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()
