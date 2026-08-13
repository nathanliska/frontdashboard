# ADR-020: Per-creator resource quotas, counted over non-purged rows

**Status:** Accepted
**Date:** 2026-08-12

## Context

Activity and notifications are pruned at 90 days. Lists, list items, calendar events and dashboards
have no horizon at all — they are kept until someone deletes them. Rate limits bound writes per
minute and deliberately not the total ([ADR-013](ADR-013-rate-limit-cf-connecting-ip.md)), so a
patient client staying under any sane rate limit could grow the database without bound. Registration
is open to anyone with a verifiable email, so "a user would not do that" is not an argument.

Storage cost per row was measured on PostgreSQL 17 against the real column types and indexes, with
incompressible content so TOAST could not flatter the result:

| Row | Typical | Largest the schemas permit |
|---|---|---|
| List item | 275 B | 3,212 B |
| Calendar event | 356 B | 6,907 B |

Field lengths are already bounded (item text 2,000 chars; event description 5,000), so no single row
can be enormous — which is what makes a *row count* a meaningful proxy for bytes.

## Decision

**Cap per creator, and count rows that have not been purged — trashed ones included.**

Nested per-container caps alone cannot do this: dashboards × lists × items multiplies into a ceiling
of hundreds of gigabytes at any per-container numbers generous enough to be usable. So the storage
bound is a per-creator total, and the per-container caps that remain exist to keep a single view
renderable, not to bound storage.

Counting trashed rows is the load-bearing half. A trashed row holds its storage until the reaper
purges it ([ADR-007](ADR-007-soft-delete-boundary.md)), so a cap over live rows only would be
bypassed by deleting and recreating — the ceiling would bound nothing while appearing to.

The caps are set well above any plausible human use, which is what keeps that honest: nothing
reclaims trash early, so a cap a person could actually reach would strand them until the reaper ran.
Defaults land near a 115 MB ceiling per account against roughly 7 MB for a heavy household running
for years.

Enforcement is on **create only**. Reads, edits and deletes are never gated, so an account already
over a lowered cap keeps everything it has and simply cannot add more — grandfathering with no
migration and no backfill.

## Consequences

- **Counts are computed, never stored.** A `COUNT` bounded by `LIMIT :cap` costs the same whether an
  account is empty or full, and it self-heals: when the reaper or a future account deletion removes
  rows, the allowance returns with no counter to decrement and no path that can forget to.
- **The check is unlocked.** Two concurrent creates can both pass at one below the cap and overshoot
  by one. Meaningless for a storage bound, and not worth serialising every create to prevent.
- **`list_items` gained an index on `created_by`.** The per-creator count filters on that column
  alone — trashed rows count, so it cannot ride the existing `deleted_at` composites — and without
  it the check would sequentially scan on the path of every item create.
- **Reclaiming space is explicit.** Deleting moves rows to the trash, where they still count; the
  trash view carries a permanent-delete that purges the cascade ahead of the reaper, loaded by
  ownership because the access door cannot see trashed rows. Without it a full account would wait
  out `trash_retention_days`.
- **Per-account, not per-attacker.** Someone willing to burn verified email addresses multiplies
  their ceiling by registering again. What bounds that is the edge — a challenge on registration —
  not this. The two are complementary; neither substitutes for the other.

## Related

- [ADR-007](ADR-007-soft-delete-boundary.md) — why a deleted row lingers at all.
- [ADR-013](ADR-013-rate-limit-cf-connecting-ip.md) — the rate limit this deliberately does not duplicate.
