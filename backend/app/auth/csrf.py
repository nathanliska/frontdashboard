import secrets


def generate_csrf_token() -> str:
    return secrets.token_hex(32)
