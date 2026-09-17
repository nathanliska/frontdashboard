# FDR-001: Authentication & Sessions

**Status:** Active
**Last reviewed:** 2026-09-16

## Overview

The account and session system: how a user registers, verifies their email, logs in, stays logged
in across a browser, and gets logged out. It exists to give a self-hosted household a real
multi-user account model with immediate, per-device session control — not just a shared password.

## Behavior

- **Registration → email verification → login.** A new user registers, receives a verification
  email, and must verify before they can log in. Registration also creates a default "My Dashboard".
- **Email identity is case-insensitive.** Addresses are normalized (trim + lowercase) at the API
  boundary, so casing can't create duplicate accounts or block login. Display names are trimmed,
  non-empty, and ≤100 characters.
- **Login is uniform on failure.** A wrong password and an unknown account return the same 401, with
  no observable timing difference.
- **A password must not be one attackers already spray.** At registration, reset and change, the
  chosen password is screened against the breach-derived common-password list and refused with a
  422 naming the reason. The answer depends on the password alone, so it stays uniform across known
  and unknown addresses. Existing passwords are never re-screened — nobody is locked out by the
  policy arriving, and the check only binds the next time one is set.
- **Sessions are per-login and revocable.** Each login is its own session. Logging out ends that
  session immediately. Changing your password ends every *other* session but keeps the one you're
  using; a password reset ends sessions accordingly.
- **Staying logged in is seamless.** One cookie stays valid for the life of the session — there is
  no background renewal to fail — and multiple tabs share it without interfering. A session that's
  been revoked stops working within seconds, including its live event stream.
- **Sessions expire two ways.** After 7 days without use (idle), or 30 days after login however
  actively used (absolute). Both are enforced server-side.
- **Password reset and change.** Reset via emailed link; authenticated users can change their
  password or rename their profile. The reset page checks the link before offering a form, so an
  expired, spent or unknown one says so instead of failing after the password is typed. The check
  reports validity only — never whose account it is — and does not consume the token.
- **Following a link can change who you are, and says so.** A verification link signs you in as the
  account it was sent to; opening one while already signed in asks first. A reset link sets the
  password for its own account, which a signed-in visitor is told may not be theirs.
- **Emails.** Verification and reset emails send in the background via Resend; without an API key the
  link is written to `backend/.dev-mail/` (how you get tokens in local dev).
- **Profile page.** Display name, password change, home-dashboard preference, and active sessions.
  The session panel pages through live sign-ins, newest first, each titled by the browser and
  platform that signed in ("Firefox on Linux", or "Unknown device"), with sign-in and last-active
  times and the current session marked. Only the account owner can list or revoke them; current-session
  revocation uses the ordinary Sign out flow. A successful revocation removes its row locally.
  Refresh explicitly checks changes on other devices. The label comes from the User-Agent's
  browser and platform tokens and is all that is recorded: no IP address and no User-Agent string
  ([ADR-003](../adr/ADR-003-first-class-sessions.md)). A desktop-mode iPad sends the Mac string and
  so reads as Mac; a definite coarse answer beats a hedge every Mac user would see.
- **An account can be deleted, from the profile page, against the password.** Refused while the
  person owns a dashboard someone else can see — hand it over ([FDR-004 §8](FDR-004-sharing-and-access.md))
  or delete it first. Otherwise their own dashboards are purged outright, their memberships,
  invites and notifications go, every session ends, and the address is free to register again.
  What they added to other people's dashboards, and where they were named on them, stays,
  credited to "Deleted user" (decision 7); the other members get the same "left" frame a leave
  sends.
- **A refused password change keeps you signed in, and says which field was wrong.** Mistyping the
  current password answers **403**, not 401 — a 401 is the client's only signal that a session is
  gone, so it signed people out of the form they were using. Both refusals, the wrong current
  password and a breached new one, attach to the field that caused them rather than raising a toast.

## Design Decisions

### 1. The credential lives in an HttpOnly cookie, guarded by an Origin check and CSRF double-submit

**Decision:** An opaque session token in an HttpOnly cookie (`__Host-` prefixed in production);
non-GET requests must pass an `Origin` check *and* carry a double-submit CSRF token.
**Why:** Keeps the credential unreadable by JavaScript (XSS can't steal it) while defending the
automatic cookie send against CSRF; the prefix stops a sibling subdomain planting a session value.
`Origin` is a forbidden header, so it cannot be forged by script, and unlike the token pair it holds
no state that can drift out of sync — the two checks fail in different ways on purpose. A request
without `Origin` still has to satisfy the token pair, so the check cannot lock anyone out.
See ADR-002.
**Tradeoff:** Every mutating route must opt into the CSRF dependency, and cookie names differ
between development and production, so nothing may hard-code them — and because the old name
survives a rename in the browser, the client must try the names in a defined order rather than
treat the prefix as optional.

### 2. Sessions are first-class rows, checked every request — and are the whole credential

**Decision:** One `sessions` row per login, holding the SHA-256 of the cookie's token; every request
resolves that row. Two clocks bound it: idle (`last_used_at`) and absolute (`expires_at`).
**Why:** A stateless token can't be revoked before expiry, so logout and password-change revocation
need a server-side handle. See ADR-003.
**Tradeoff:** A session-liveness read on every authenticated request — accepted, and it is precisely
what made a separate short-lived access token redundant.

### 3. No token rotation, and no theft detection

**Decision:** The access/refresh split and single-use rotating refresh tokens were removed
2026-07-28. One credential, never rotated.
**Why:** Because revocation was already immediate, a short access-token lifetime bounded nothing —
while the mandatory periodic refresh call turned any deploy or proxy blip into a logout, and reuse
detection read a *lost response* as theft and killed the session. Both were observed in production.
See ADR-003.
**Tradeoff:** Nothing now signals that a session cookie has been copied. The compensating controls
are the absolute timeout and server-side revocation; the active-session panel is the
control for inspecting and revoking other sign-ins.

### 4. Login is enumeration-safe and constant-work

**Decision:** Login always performs exactly one Argon2 verify (against a fixed dummy hash for unknown
emails) and returns an identical 401 for missing-account and wrong-password.
**Why:** Removes both the response and timing oracles that would reveal which accounts exist. See
ADR-011.
**Tradeoff:** Every login pays a full Argon2 verify, even for nonexistent accounts. Register-time
enumeration is separately accepted as a deliberate household-scale risk.

### 5. Argon2 runs off the event loop under a bounded limiter

**Decision:** Password hashing runs in a worker thread under a shared capacity limiter
(`argon2_max_concurrency`, default 4).
**Why:** Keeps a login burst from stalling the async event loop and bounds Argon2's memory cost. See
ADR-010.
**Tradeoff:** Under heavy burst, logins queue on the limiter and add latency.

### 6. Client state is wiped and generation-guarded at every auth boundary

**Decision:** Login, logout, verification, and unauthenticated startup clear all client state; a
session-generation counter drops any in-flight async write whose boundary has since been crossed.
A delayed 401 from a request begun before that boundary cannot expire the new session. A startup
that cannot reach the server is neither boundary: the shell shows a retry, not the login page. A
sign-out whose server call fails keeps the local reset and says the session may still be live,
with a retry.
**Why:** Prevents one account's cached or in-flight data from leaking into the next account in the
same tab. See ADR-012.
**Tradeoff:** Every account-scoped store must adopt the generation-guard pattern and a reset hook.

### 7. Deleting an account tombstones the row rather than removing it (decided 2026-09-16)

**Decision:** `DELETE /auth/account` re-checks the password, purges every dashboard the person owns
(trashed ones included), removes their memberships, invites and notifications, revokes every
session, and rewrites the `users` row in place: a reserved-domain email carrying the id, an
unusable password hash, "Deleted user" as the name, `deleted_at` set. The row is never removed.
Owning a *live* dashboard others can see is a 409 naming it; a trashed one is not, since its
members were told at trash time and only the owner could have restored it.
**Why:** The authorship columns (`created_by`, `updated_by`, `actor_id`) and the presence rows
(assignee, event participant) point at `users.id` with no cascade, and that is right — a list item
or event on a shared dashboard belongs to the household, not to the person who typed it, and a
leave already keeps them. The tombstone is what lets every one of those keep pointing somewhere
and render as "Deleted user"; only the person's *access* — the share rows — is withdrawn, with
the same frame to the remaining members as a leave. Purging owned dashboards rather than trashing
them follows from the 409: by the time the call succeeds, no one else could see them, and a trash
nobody can sign in to restore from is a 30-day delay with no beneficiary.
**Tradeoff:** A `users` tombstone is the one soft-deleted row nothing can clear — the exception to
[ADR-007](../adr/ADR-007-soft-delete-boundary.md)'s invariant, recorded there. Because the row is
never removed, no `users.id` foreign key can ever refuse a deletion, so a table this path forgets
fails silently: its rows keep naming the tombstone. The reaper's abandoned-signup sweep and this
path both list those FKs by hand, and a new one belongs in both. The precondition is unlocked: an
invite redeemed in the window between the check and the purge lands on a dashboard that then
vanishes, the same outcome as an owner deleting a dashboard right after someone joined.

## Access

Authentication *is* the access boundary for the account itself. Resource-level access (owner /
editor / viewer) is covered in [FDR-004](FDR-004-sharing-and-access.md).

## Related

- **ADRs:** ADR-002 (credential cookies + Origin check + CSRF), ADR-003 (first-class sessions), ADR-010 (Argon2 off the
  event loop), ADR-011 (enumeration-safe login), ADR-012 (session-generation guard), ADR-013 (rate
  limiting), ADR-014 (fail-fast prod config)
- **FDRs:** FDR-004 (Sharing & Access), FDR-008 (Real-Time Delivery)
