import anyio
from anyio.to_thread import run_sync
from argon2 import PasswordHasher
from argon2.exceptions import VerificationError, VerifyMismatchError

from app.config import settings
from app.metrics import ARGON2_SECONDS

_ph = PasswordHasher()

# Verified against on the login miss path so an unknown email pays the same Argon2 cost as a
# real one — closes the user-enumeration timing oracle (finding #43). Uses `_ph`, so its verify
# cost always matches real hashes.
_DUMMY_HASH = _ph.hash("frontdashboard-login-timing-equalizer")

# One shared limiter bounds peak concurrent Argon2 work (each op ~64 MiB, and parallelism=4
# already saturates a few cores at low N). When full, further auth requests queue instead of
# stalling the event loop (finding #13).
argon2_limiter = anyio.CapacityLimiter(settings.argon2_max_concurrency)


def _hash(password: str) -> str:
    return _ph.hash(password)


def _verify(password: str, hashed: str) -> bool:
    try:
        _ph.verify(hashed, password)
        return True
    except (VerifyMismatchError, VerificationError):
        return False


async def hash_password(password: str) -> str:
    with ARGON2_SECONDS.labels(operation="hash").time():
        return await run_sync(_hash, password, limiter=argon2_limiter)


async def verify_password(password: str, hashed: str) -> bool:
    with ARGON2_SECONDS.labels(operation="verify").time():
        return await run_sync(_verify, password, hashed, limiter=argon2_limiter)
