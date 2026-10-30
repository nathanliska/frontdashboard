"""Refuse addresses at throwaway-inbox services wherever an account can take one.

Open registration makes an address the price of an account, and quotas and rate limits are per
account; a disposable inbox prices that at nothing. The list is the community-maintained one, which
excludes privacy relays — those are permanent inboxes, so an alias still registers.

This raises the cost of a second account rather than closing it: a domain of one's own, or a
service not yet listed, still gets through. Quotas and rate limits remain the controls.
"""

import contextlib

from disposable_email_domains import blocklist
from fastapi import HTTPException, status

_DISPOSABLE_DETAIL = "Disposable email addresses can't be used. Please use a permanent address."


def is_disposable_email(email: str) -> bool:
    """Whether the address's domain, or any parent of it, is a listed throwaway service."""
    domain = email.rpartition("@")[2].lower()
    # The list spells internationalised domains in ASCII; the validator hands back Unicode. The codec
    # is IDNA2003 and the validator IDNA2008, so a domain one accepts the other may refuse.
    with contextlib.suppress(UnicodeError):
        domain = domain.encode("idna").decode("ascii")
    labels = domain.split(".")
    # Parents too: these services hand out any subdomain, and the list names only the registrable one.
    return any(".".join(labels[i:]) in blocklist for i in range(len(labels)))


def assert_email_not_disposable(email: str) -> None:
    """Reject an address at a disposable-email service.

    The answer depends on the domain alone, so it says nothing about whether the address has an
    account (ADR-011).

    Raises:
        HTTPException: 422 when the domain is listed.
    """
    if is_disposable_email(email):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=_DISPOSABLE_DETAIL)
