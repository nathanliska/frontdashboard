# FDR-001: Authentication & Sessions

**Status:** Active
**Last reviewed:** 2026-09-19

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
- **An address can be changed, against the password.** The new address gets a link and nothing
  changes until it is confirmed; the current address is told at once, and told how to stop it.
  Confirming works signed-out and signs no one in. A taken address looks exactly like a free one
  to the person asking (decision 8).
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
  or delete it first. Otherwise their own dashboards are purged outright, their memberships, the
  invites they issued and their own notifications go, every session ends, their rows in the
  activity log are renamed to the tombstone's, and the address is free to register again. What
  they added to other people's dashboards, and where they were named on them, stays, credited to
  "Deleted user" (decision 7); the other members get the same "left" frame a leave sends.
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

**Decision:** `DELETE /auth/account` re-checks the password, locks the account and the dashboards
it owns, purges every one of those dashboards (trashed ones included), removes their memberships,
the invites they issued and their own notifications, revokes every session, renames them to
"Deleted user" across the activity log, and rewrites the `users` row in place: a
reserved-domain email carrying the id, an unusable password hash, "Deleted user", `deleted_at`
set. The row is never removed. Owning a *live* dashboard others can see is a 409 naming it; a
trashed one is not, since its members were told at trash time and only the owner could have
restored it.
**Why:** The authorship columns (`created_by`, `updated_by`) and the presence rows (assignee,
event participant) point at `users.id` with no cascade, and that is right — a list item or event
on a shared dashboard belongs to the household, not to the person who typed it, and a leave
already keeps them. The tombstone is what lets every one of those keep pointing somewhere and
render as "Deleted user"; only the person's *access* — the share rows — is withdrawn, with the
same frame to the remaining members as a leave. Purging owned dashboards rather than trashing
them follows from the 409: by the time the call succeeds, no one else could see them, and a trash
nobody can sign in to restore from is a 30-day delay with no beneficiary.
**What the lock buys:** the precondition and the purge become one critical section. `accept_invite`
takes the same dashboard row before it consumes the code, so a redemption racing the purge waits and
then finds the dashboard gone — the ordinary "no longer valid" answer. Consuming first would hold
the invite row the purge deletes while waiting on the dashboard the purge holds: a deadlock. The
account itself is a transaction-scoped advisory lock rather than a lock on the `users` row. It
serialises a second submit of the same deletion, and `transfer_dashboard_ownership` takes it for the
incoming owner, so a hand-over waits out a deletion and then refuses the tombstone instead of
stranding a dashboard on it. An ordinary write never takes it, and the few paths that do (decision
8) take it before they touch a row, so nothing waits on it while holding what this call needs. A
lock on the row would not have that property: a password reset writes the user row after spending
its token, which the deletion sweeps. Leaving the row unlocked does let a write from the person's
own second tab land while the deletion runs: a dashboard created in that moment outlives it, owned
by the tombstone and reachable by no one; an invite redeemed in it leaves "Deleted user" listed as a
member until the owner removes them; and a list item added to a dashboard being purged fails the
deletion once, which a retry clears. Only the person deleting can cause any of these, so they are
accepted rather than locked against. One race is not theirs: the retention reaper sweeps expired
tokens and sessions before trashed dashboards, the reverse of this call's order, so a tick that
meets this account's expired token and a trashed dashboard of theirs crossing 30 days in the same
moment deadlocks with it. One side fails, and the next tick or a retry clears it.
**What is not erased:** `activity_events` snapshots the actor's name rather than joining to it, so
the name is rewritten there. That is hygiene at rest rather than something the person is shown —
the feed is self-scoped, and a deleted account can never sign in to read its own. The *payloads*
keep what they wrote (a list item's text, an event's title) until the 90-day history sweep takes
the rows. Notifications already delivered to other people quote the name in their body and are
left alone, like a sent message; they age out on the same sweep. A redeemed invite keeps
`redeemed_by` pointing at the tombstone until the reaper prunes it after expiry. Say so before
calling the account erased: it is detached and anonymised, not expunged.
**Tradeoff:** A `users` tombstone is the one soft-deleted row nothing can clear — the exception to
[ADR-007](../adr/ADR-007-soft-delete-boundary.md)'s invariant, recorded there. Because the row is
never removed, no `users.id` foreign key can ever refuse a deletion, so a table this path forgets
fails silently: its rows keep naming the tombstone. The reaper's abandoned-signup sweep and this
path both list those FKs by hand, and a new one belongs in both. The rename is also a single
unbounded `UPDATE` inside the deletion's transaction — bounded in practice only by the 90-day
horizon — so an account noisy enough to exceed the 15s statement timeout would fail to delete
itself and keep failing; batching it is the fix if that ever stops being hypothetical.

### 8. An address changes on the new inbox's confirmation; the old inbox is warned, not asked (decided 2026-09-19)

**Decision:** `POST /auth/email-change` takes the new address and the current password, stores a
pending change (`email_change_tokens`, one hour, a newer request superseding an older), mails the
new address a confirm link and the current address a notice. `POST /auth/email-change/confirm`
spends the token, switches `users.email`, and voids reset links already mailed to the old address.
It needs no session and mints none. Changing or resetting the password voids any pending change,
and the notice says so.
**Why:** The new address must prove itself *before* the switch, or a typo locks the account out for
good. The old address is told when the change is *requested*, while it can still be stopped, rather
than after. It is not asked to confirm: the usual reason to change an address is having lost the old
inbox, and with no help desk a second confirmation would strand exactly those people. The password
is the second factor instead, so a stolen session alone cannot move the account. Cancelling by
password change needs no new endpoint and is the right reflex anyway, since it ends every session.
**Enumeration:** the requester reads the current inbox, so everything they can observe is the same
for a taken address as for a free one — the 204, the stored token, the notice. The one difference
is that a taken address is never mailed its link, which only its owner could see
([ADR-011](../adr/ADR-011-enumeration-safe-login.md)). The cost is that a person who mistypes into
someone else's address hears nothing about why no link arrived.
**Tradeoff:** The notice is a warning, not a veto. Whoever holds both the session and the password
can confirm to their own inbox within seconds, and after that the old address resets nothing: the
owner's way back is the maintainer. Requiring the old inbox to confirm is what would close that, and
it is the thing ruled out above.
**Serialisation:** a void is one statement, so on its own a reset requested in the milliseconds
before a confirm commits would leave a live link in the old inbox, and a change requested during a
password reset would survive it. Every path that moves or cancels a change — both halves of this
flow, both halves of a reset, and a password change — therefore takes the account's advisory lock
(decision 7) before it writes or locks a row, and re-reads what it decided on. Taken first, it
cannot join a cycle: a reset used to spend its token and then wait, which against a deletion
sweeping that token was a deadlock. Within the lock the confirm path still voids reset tokens before
spending its own, because the retention sweep, which takes no account lock, walks the tables in that
order.

## Access

Authentication *is* the access boundary for the account itself. Resource-level access (owner /
editor / viewer) is covered in [FDR-004](FDR-004-sharing-and-access.md).

## Related

- **ADRs:** ADR-002 (credential cookies + Origin check + CSRF), ADR-003 (first-class sessions), ADR-010 (Argon2 off the
  event loop), ADR-011 (enumeration-safe login), ADR-012 (session-generation guard), ADR-013 (rate
  limiting), ADR-014 (fail-fast prod config)
- **FDRs:** FDR-004 (Sharing & Access), FDR-008 (Real-Time Delivery)
