# Agent 3: Data Exposure & Lifecycle

SSE fan-out audience — who receives an event after a share is revoked, a dashboard is trashed, or a
user is deleted; the activity feed and notification staging; soft delete, the trash and the 30-day
reaper; retention sweeps; credentials or tokens reaching logs; metric labels carrying user data or
unbounded cardinality.

The traps: events are addressed with `dashboard_audience_user_ids(...)` and committed through
`commit_and_broadcast(...)` — a content event addressed to an
audience from before a permission change leaks to whoever just lost access. A removal notice is
the deliberate exception: its audience is taken before the delete, so the removed user's tabs
receive it and drop the dashboard. A table with a `dashboard_id` or `users` foreign key that is missing from the
matching sweep in `services/retention.py` either outlives the purge or rolls back the whole tick,
because none of those FKs cascade.

Key files: `backend/app/sse/`, `backend/app/services/activity.py`,
`backend/app/services/notifications.py`, `backend/app/services/retention.py`,
`backend/app/metrics.py`, `backend/app/models/`
