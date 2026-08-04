import inspect

from argon2 import PasswordHasher

from app.auth.hashing import hash_password, verify_password


async def test_hash_and_verify_round_trip() -> None:
    hashed = await hash_password("correct horse battery staple")
    assert hashed != "correct horse battery staple"
    assert await verify_password("correct horse battery staple", hashed) is True


async def test_verify_rejects_wrong_password() -> None:
    hashed = await hash_password("correct horse battery staple")
    assert await verify_password("wrong password", hashed) is False


def test_hash_and_verify_are_coroutine_functions() -> None:
    assert inspect.iscoroutinefunction(hash_password)
    assert inspect.iscoroutinefunction(verify_password)


def test_production_profile_stays_strong(production_argon2: PasswordHasher) -> None:
    """RFC 9106's second recommendation, which nothing else would notice being weakened.

    The rest of the suite runs at minimum cost, and the profile comes from argon2-cffi's defaults —
    so a dependency bump that lowered them would otherwise ship silently.
    """
    assert production_argon2.memory_cost >= 64 * 1024
    assert production_argon2.time_cost >= 3
    assert production_argon2.parallelism >= 4
