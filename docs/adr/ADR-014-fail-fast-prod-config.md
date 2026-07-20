# ADR-014: Fail-Fast Production Configuration Validation

**Date:** 2026-07-20

## Context

The most dangerous configuration failure is the silent one: a production deploy that boots
*successfully* but insecurely — a default/placeholder signing secret, no configured mail sender, or
an unset environment that leaves cookies in their permissive dev posture. Such a deploy looks healthy
and serves traffic while being quietly compromised.

## Decision

Make insecure production configuration a **boot failure**, not a runtime surprise.

- `ENVIRONMENT` is a **required, validated enum** — a prod deploy that forgets it won't boot, rather
  than defaulting to an insecure mode.
- Production startup **aborts** on: a weak/placeholder `secret_key` (< 32 chars), a missing
  `resend_api_key`, or an undeliverable `email_from`.
- Startup **logs the active environment and cookie posture** (`INFO` in prod, `WARNING` otherwise),
  so the security-relevant configuration is visible in the logs of every boot.

## Consequences

- **A misconfigured prod deploy dies loudly at boot** instead of running compromised — the failure is
  immediate and points at the offending setting.
- **Config becomes part of the deploy contract**: operators must supply a strong secret, a mail key,
  and a deliverable from-address for production to start. That's stricter, deliberately.
- **Dev stays frictionless**: the strict checks are gated on the production environment; non-prod
  logs a `WARNING` about its posture but still boots.
- **Log line as an audit surface**: the startup posture line is the quick check that a running
  instance is in the mode you think it's in.
