import inspect

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
