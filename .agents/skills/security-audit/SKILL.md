---
name: "security-audit"
description: "Whole-codebase security audit — parallel agents across auth, abuse, data exposure and serving, then an adversarial pass that verifies every finding against the source. Manual: started by the user when asked for a security audit, never self-started."
disable-model-invocation: true
---

# Security Audit

A full-codebase audit. For the pending changes on a branch, Claude Code's built-in
`/security-review` is the narrower tool — reach for this one when the question is about the whole
system rather than a diff. It is manual: the user starts it. The per-PR check is the *Security
pass* in `pr-checklist`.

Two rules override anything an agent decides on its own:

- **Read the source, never guess.** Every finding cites a path and line, and a finding whose cited
  line does not say what the finding claims is a false positive, not a rounding error.
- **No small-deployment discount.** See the exposure below. "Only a logged-in user can reach it" is
  not a mitigation when anyone can sign up.

## Exposure

Public on the internet, registration open to anyone holding a verifiable email, ~100 users and a few
concurrent, one backend worker, behind Cloudflare and Caddy. The product is household-shaped; the
deployment is not private. Abuse, enumeration and data-privacy findings are rated on that basis.

## Phase 1: Parallel Review Agents

Launch **4 agents in parallel** (Agent tool, `subagent_type: general-purpose`), one per surface.
Each reads actual source, cites `path:line`, rates Critical/High/Medium/Low/Info, gives a concrete
attack scenario and a suggested fix, and notes the patterns this codebase gets right.

Give each agent the path to its brief and tell it to read that file first. Do not read the
briefs into this session.

| Agent | Surface | Brief |
|---|---|---|
| Agent 1 | Authentication & Access Control | [briefs/1-auth-access.md](briefs/1-auth-access.md) |
| Agent 2 | Input Validation, Enumeration & Abuse | [briefs/2-input-abuse.md](briefs/2-input-abuse.md) |
| Agent 3 | Data Exposure & Lifecycle | [briefs/3-data-lifecycle.md](briefs/3-data-lifecycle.md) |
| Agent 4 | Frontend & Serving | [briefs/4-frontend-serving.md](briefs/4-frontend-serving.md) |

## Phase 2: Compile

Deduplicate into one report in the session scratchpad — **not** in the repo, which ignores no
scratch directory. Group by severity and mark anything two agents found independently; agreement
across surfaces is the strongest signal available before verification.

## Phase 3: Adversarial Verification

Launch **one** agent that does not trust the previous four. It re-reads the source at every cited
line and rates each finding **CONFIRMED**, **CONFIRMED-DOWNGRADE**, **CONFIRMED-UPGRADE**, **FALSE
POSITIVE** or **NEEDS-MORE-INVESTIGATION**, then adds what the others missed. Direct it at:

- Mitigations the auditors did not see — a dependency, middleware, or a database constraint.
- The known good patterns below, which are design, not defects.
- Permission edge cases at the owner/editor/viewer boundary.
- Ordering: an event built after its commit, or a content event addressed to an audience from
  before a permission change.
- Anything reachable before authentication, weighed against open registration.

## Phase 4: Report

Summary table with final severities, then a fix order that puts quick wins first. Confirmed findings
append to [docs/TODO.md](../../../docs/TODO.md) with the next free number, per its own maintenance
rule — that file is the backlog, and a finding that lives only in a report is a finding that gets
lost. Say plainly which surfaces were audited thinly or not at all.

## Known Good Patterns

Design decisions, not vulnerabilities. A finding that contradicts one of these needs to argue with
the ADR, not merely observe the behavior:

- `/shares` on lists and calendar events returns **409 by design** — those inherit access from the
  dashboard whose widget binds them. It is a deliberate stub, not a missing endpoint.
- The owner holds no share row: `effective_role` resolves the creator to `owner` and raises 404
  for a non-member.
- One opaque session cookie resolved per request; no JWT, no refresh token, no `/auth/refresh`, no
  tokens in `localStorage` ([ADR-002](../../../docs/adr/ADR-002-httponly-cookie-csrf.md),
  [ADR-003](../../../docs/adr/ADR-003-first-class-sessions.md)).
- Registration is open to anyone with a verifiable email. Enumeration and abuse findings still
  stand; "unauthenticated users can register" on its own does not.
- SSE is one multiplexed stream per open tab, fanned out by user — three tabs are three streams.
- There is no archive state; DELETE puts a dashboard or list in the trash for 30 days
  ([ADR-007](../../../docs/adr/ADR-007-soft-delete-boundary.md)).
- Argon2 runs at its **minimum** cost under test. The real profile is ~64 MiB and four threads; take
  the `production_argon2` fixture before concluding the parameters are weak.
