import anyio
from argon2 import PasswordHasher
from argon2.exceptions import VerificationError, VerifyMismatchError

from app.config import settings

_ph = PasswordHasher()

# One shared limiter bounds peak concurrent Argon2 work (each op ~64 MiB, and parallelism=4
# already saturates a few cores at low N). When full, further auth requests queue instead of
# stalling the event loop (finding #13).
_argon2_limiter = anyio.CapacityLimiter(settings.argon2_max_concurrency)


def _hash(password: str) -> str:
    return _ph.hash(password)


def _verify(password: str, hashed: str) -> bool:
    try:
        _ph.verify(hashed, password)
        return True
    except (VerifyMismatchError, VerificationError):
        return False


async def hash_password(password: str) -> str:
    return await anyio.to_thread.run_sync(_hash, password, limiter=_argon2_limiter)


async def verify_password(password: str, hashed: str) -> bool:
    return await anyio.to_thread.run_sync(_verify, password, hashed, limiter=_argon2_limiter)
