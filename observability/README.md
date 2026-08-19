# Observability

Dashboards, alert rules, and notes for the Prometheus host they read from.

## Dashboards

- **`frontdashboard-overview.json`** (uid `frontdashboard`) — is the app healthy for the people
  using it? Liveness, restarts, the two SLIs, request rate, errors, latency, auth failures.
- **`frontdashboard-internals.json`** (uid `frontdashboard-internals`) — why it looks that way.
  Pool, Argon2, SSE, shared Redis state, process resources.

Split because twenty-odd panels on one page is a scanning problem at the moment you can least
afford one. The overview answers *whether*; internals answers *where*. A shared `frontdashboard` tag
cross-links them in each one's top-right dropdown.

Neither carries an `__inputs` block — a `datasource` variable instead, so panels bind to whichever
Prometheus is picked at import and can be repointed later.

## Loading these into Grafana

By hand, from the browser. No token, nothing written to the deployment host.

**Dashboards first**, since the rules link to their panels by id: *Dashboards → New → Import*, paste
the JSON, pick the data source. The `uid` in the file matches an existing dashboard, so a re-import
updates rather than duplicates.

**Then the rules**: *Alerting → Alert rules → Import rules → Prometheus YAML file*, upload
`alerts.yml`, choose a target folder and the data source.

Four things worth knowing about that import:

- **Untick "pause imported rules".** It defaults to *on*, and a paused rule never evaluates —
  `lastEvaluation` stays at the zero time while the list shows nineteen healthy, inactive rules. It
  looks exactly like working alerting and is inert. If they are already in, select all and
  *More → Resume evaluation*.
- **Prometheus format is the only one that works.** Grafana's own provisioning format exports but
  never imports; it can only be mounted as a file inside the container, on the NAS.
- **No-data semantics survive the conversion** — an empty result leaves a rule Normal rather than
  raising No Data. Most of these expressions return nothing whenever things are healthy.
- **Re-importing updates in place.** Each rule pins `__grafana_alert_rule_uid__`. Deletion is still
  manual: dropping a rule here leaves it firing in Grafana with nothing left to explain it.

Imported rules stay editable in the UI, unlike file-provisioned ones — try a threshold in the
browser, then write it back here.

**Contact points are not in this repo**; they hold a webhook URL or an SMTP password. Create one in
*Alerting → Contact points* and route `severity = critical` to it under *Notification policies*.
That is six of the nineteen — the rest stay visible and silent, because nineteen notifications is
how alerting starts being ignored.

## Editing

Change the files here, not the browser, and validate every query against a live Prometheus first. A
panel reading "No data" from a typo is indistinguishable from one whose metric has no samples yet.

**Run the query; do not merely parse it.** A rule naming a series nothing produces is *valid* PromQL
that evaluates to nothing forever, so a syntax check passes it and the rule is disabled rather than
broken. `promtool check rules` in CI catches the syntax half; only executing the expression catches
the other, and `test_observability_coverage.py` can only vouch for `frontdashboard_*` names, which
it resolves against the code's own registry.

**Every metric that comes from an exporter therefore needs an `absent()` companion**, because
nothing else can tell a healthy quiet rule from one whose scrape job was never added.
`PublicProbeMissing` is that pattern; add one alongside the next exporter.

## The Prometheus side

Three things that live on the Prometheus host, none of which Grafana can hold.

### Watch the site from outside

Every other target is inside the Docker network, so all of it stays green while Caddy, the frontend
container or Cloudflare is what broke. `blackbox_exporter` is the only check that sees what a user
sees. Install it from Community Applications, then:

```yaml
scrape_configs:
  - job_name: blackbox-public
    metrics_path: /probe
    params:
      module: [http_2xx]
    static_configs:
      - targets:
          - https://dash.example.com/
          - https://dash.example.com/api/health/ready
    relabel_configs:
      - source_labels: [__address__]
        target_label: __param_target
      - source_labels: [__param_target]
        target_label: instance
      - target_label: __address__
        replacement: blackbox-exporter:9115
```

The probe has to leave the host and come back through Cloudflare; an internal address would test the
one path already covered.

Don't expect to see it in the backend log. `/api/health/ready` is proxied like any `/api/*` route,
so this probe — and any other external uptime check pointed at it — does reach uvicorn, but at
`LOG_LEVEL=info` the access line is dropped while it answers under 400, along with the container
HEALTHCHECK and the metrics scrape. The prober's own history is the record, and unlike a log line
it can be alerted on. A failing probe still logs.

**Point external uptime checks at `/api/health/ready`, not `/api/health`.** Liveness touches
nothing by design, so it answers 200 straight through a database outage — an uptime monitor on it
reads 100% while nobody can use the site. Readiness answers 503 with `database: false` instead.
It costs a `SELECT 1` per check, which is worth budgeting if the interval is short.

### Cap the disk, not just the age

The container ships `--storage.tsdb.retention.time=15d` with `retention.size` unset, so runaway
cardinality fills the array rather than evicting. Add to **Extra Parameters** in the host's
template:

```
--storage.tsdb.retention.size=5GB
```

Whichever limit is hit first wins, so this only ever acts as a floor under the disk.

### Close the UI back up

`web.config.file` is empty, so `:9090` serves every metric and 15 days of history to anything on the
LAN, unauthenticated. That is the same data [`routers/metrics.py`](../backend/app/routers/metrics.py)
deliberately keeps off `/api`.

```yaml
# web-config.yml — then add --web.config.file=/etc/prometheus/web-config.yml
basic_auth_users:
  admin: <bcrypt hash — htpasswd -nBC 12 "" | tr -d ':\n'>
```

Grafana's data source then needs the same credentials under **Basic auth**.
