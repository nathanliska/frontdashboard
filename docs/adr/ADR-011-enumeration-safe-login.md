# ADR-011: Enumeration-Safe, Constant-Work Authentication

**Date:** 2026-07-20 · **Amended:** 2026-07-25 (extended from login to registration)

*(Filename says "login" for link stability; the decision now covers every unauthenticated endpoint
that takes an email address.)*

## Context

An endpoint that behaves differently for "unknown email" versus "known email" leaks which accounts
exist. The leak has two channels:

- **Response channel**: different status codes or messages for the two cases.
- **Timing channel**: skipping the (expensive) Argon2 work when the email is unknown makes the
  "no such account" response measurably faster than the one that pays for a full hash or verify.

Login was addressed first. Registration was initially left leaking a `409 "Email already
registered"`, accepted on the premise that signup was near-closed. **That premise lapsed**:
registration is open to anyone with a verifiable email, so probing costs an attacker nothing — no
mailbox, no account, just a status code. Worse, the negative answer was not inert: a `201` meant an
unverified account had just been created on someone else's address, mailing them an unsolicited
verification link and taking the address so the real owner would later hit the `409`.

## Decision

Make these endpoints **constant-work and identical-response**:

- **Login** always performs **exactly one Argon2 verify** — against the real hash when the account
  exists, and against a **fixed dummy hash** when the email is unknown. It returns an **identical
  401** whether the account is missing or the password is wrong.
- **Registration** always performs **exactly one Argon2 hash**, before the existence check, and
  returns the **identical 201** either way. A duplicate creates nothing; instead the address owner
  is emailed "someone tried to sign up — you already have an account", with sign-in and
  password-reset links. The `IntegrityError` backstop for case-variant collisions absorbs into that
  same response rather than surfacing a 409.
- **Password reset and resend-verification** already answer with an unconditional 204.

## Consequences

- **No account-existence oracle on either surface**: neither the response nor the timing
  distinguishes "unknown email" from "wrong password" on login, or "new address" from "already
  registered" on signup.
- **Every attempt pays one Argon2 operation**: even a login for a nonexistent account, and even a
  signup that creates nothing. That cost is intentional — it's what closes the timing channel — and
  is bounded by the limiter in ADR-010.
- **The dummy hash must stay realistic**: it has to cost the same as a real verify, so it must be a
  genuine Argon2 hash with the same parameters — a cheap placeholder would reopen the timing channel.
- **Signup UX gets slower for honest mistakes**: someone who forgot they already have an account no
  longer sees an immediate "email already registered" — they get the same "check your inbox" screen
  and learn it from the email. Accepted deliberately; the confirmation screen is worded to be true
  in both cases, and re-wording it to name the verification link would restore the oracle.
- **The account-exists fact moves to a channel only its owner can read.** Email is now the sole
  place it is disclosed, which is also why the mail is worth sending: it turns a silent attempt
  into something the real owner can see.
