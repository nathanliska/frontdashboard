# Agent 1: Authentication & Access Control

Session resolution and expiry, cookie flags and the `__Host-` prefix, CSRF double-submit and the
`Origin` check, Argon2 parameters, invite and password-reset token lifecycles, share grants and
role escalation, and IDOR anywhere a resource id arrives from the client.

The traps: owner is a value `permissions.effective_role` returns for the creator, never the
absence of a role, and a non-member is a 404 raised there — read it before judging any caller.
Child resources must reach access through `load_dashboard_access` / `list_accessible_dashboard_ids`,
which filter trashed dashboards; a direct query on a child table bypasses that.

Key files: `backend/app/auth/`, `backend/app/services/permissions.py`,
`backend/app/services/shares.py`, `backend/app/services/sessions.py`,
`backend/app/services/invites.py`, `backend/app/services/password_reset.py`,
`backend/app/routers/`
