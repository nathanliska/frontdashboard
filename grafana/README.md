# Grafana dashboards

Two dashboards, deliberately split:

- **`frontdashboard-overview.json`** (uid `frontdashboard`) — is the app healthy for the people
  using it? Liveness, restarts, the two SLIs, request rate, errors, latency, auth failures.
- **`frontdashboard-internals.json`** (uid `frontdashboard-internals`) — why it looks that way.
  Pool, Argon2, SSE, process resources.

Eighteen panels on one page is a scanning problem at exactly the moment you cannot afford one. The
overview answers *whether* something is wrong; internals answers *where*. They cross-link through a
shared `frontdashboard` tag, so each lists the other in its top-right dropdown.

Neither file carries an `__inputs` block. They use a `datasource` template variable instead, which
is the only form that loads both by manual import and by provisioning.

## Provisioning (preferred)

Hand-importing means the file is version-*controlled* but not version-*applied* — the copy in
Grafana drifts from the copy in git and nothing notices. Provisioning closes that: Grafana reads the
directory every 30s, and `allowUiUpdates: false` makes the dashboards read-only so a stray click
cannot fork them.

On Unraid, add two paths to the Grafana template:

| Container path | Host path |
|---|---|
| `/etc/grafana/provisioning` | `/mnt/user/appdata/grafana/provisioning` |
| `/var/lib/grafana/dashboards` | `/mnt/user/appdata/grafana/dashboards` |

Then copy `provisioning/dashboards/frontdashboard.yml` into the first and both `*.json` into the
second, and restart the container. The dashboards appear in a **FrontDashboard** folder.

Delete the hand-imported copy first if one exists — it holds the same `frontdashboard` uid, and two
dashboards cannot.

The Prometheus data source stays hand-created. Provisioning it too would be more declarative, but
it would also mean replacing the one already working; the template variable finds it either way.

## Manual import (fallback)

`http://<grafana>/dashboard/import` → paste the JSON → **Overwrite**. Works, but you own
remembering to redo it whenever the file changes.

## Editing

Change the JSON here, not the browser. Every query in both files is validated against a live
Prometheus before commit — a panel that renders "No data" because of a typo looks identical to one
whose metric legitimately has no samples yet, so the check is not optional.
