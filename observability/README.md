# Observability

Dashboards, alert rules, and notes for the Prometheus host they read from.

## Dashboards

- **`frontdashboard-overview.json`** (uid `frontdashboard`) — is the app healthy for the people
  using it? Liveness, restarts, the two SLIs, request rate, errors, latency, auth failures.
- **`frontdashboard-internals.json`** (uid `frontdashboard-internals`) — why it looks that way.
  Pool, Argon2, SSE, process resources.

Split because twenty panels on one page is a scanning problem at the moment you can least afford
one. The overview answers *whether*; internals answers *where*. A shared `frontdashboard` tag
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
  `lastEvaluation` stays at the zero time while the list shows fifteen healthy, inactive rules. It
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
That is six of the fifteen — the rest stay visible and silent, because fifteen notifications is how
alerting starts being ignored.

## Editing

Change the files here, not the browser, and validate every query against a live Prometheus first. A
panel reading "No data" from a typo is indistinguishable from one whose metric has no samples yet.

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
          - https://dash.zalis.app/
          - https://dash.zalis.app/api/health/ready
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

### Cap the disk, not just the age

The container ships `--storage.tsdb.retention.time=15d` with `retention.size` unset, so runaway
cardinality fills the array rather than evicting. Add to **Extra Parameters** in the Unraid
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
