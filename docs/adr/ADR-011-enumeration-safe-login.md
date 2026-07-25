# ADR-011: Enumeration-Safe, Constant-Work Login

**Date:** 2026-07-20

## Context

A login endpoint that behaves differently for "unknown email" versus "known email, wrong password"
leaks which accounts exist. The leak has two channels:

- **Response channel**: different status codes or messages for the two cases.
- **Timing channel**: skipping the (expensive) Argon2 verify when the email is unknown makes the
  "no such account" response measurably faster than "wrong password", which pays for a full verify.

## Decision

Make login **constant-work and identical-response**:

- It always performs **exactly one Argon2 verify** — against the real hash when the account exists,
  and against a **fixed dummy hash** when the email is unknown.
- It returns an **identical 401** whether the account is missing or the password is wrong.

## Consequences

- **No account-existence oracle on login**: neither the response nor the timing distinguishes
  "unknown email" from "wrong password".
- **Every login pays one verify**: even a login for a nonexistent account does the Argon2 work. That
  cost is intentional (it's what closes the timing channel) and is bounded by the limiter in ADR-010.
- **Registration is a separate surface**: register-time enumeration was accepted as a deliberate
  risk on the premise of near-closed registration; this ADR governs *login* only.
  **2026-07-25 — that premise has lapsed:** registration is open to anyone with a verifiable email,
  which is the condition this ADR named for revisiting. Login behavior above is unaffected and
  stands; the registration decision is being re-taken under #55 in [docs/TODO.md](../TODO.md), and
  this ADR will be amended or superseded by that outcome.
- **The dummy hash must stay realistic**: it has to cost the same as a real verify, so it must be a
  genuine Argon2 hash with the same parameters — a cheap placeholder would reopen the timing channel.
