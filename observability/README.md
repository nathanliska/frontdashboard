# Observability

Dashboards, alert rules and the notes for the Prometheus host they read from. Everything here is
hand-synced — the repo never reaches the deployment host.

## Dashboards

Two dashboards, deliberately split:

- **`frontdashboard-overview.json`** (uid `frontdashboard`) — is the app healthy for the people
  using it? Liveness, restarts, the two SLIs, request rate, errors, latency, auth failures.
- **`frontdashboard-internals.json`** (uid `frontdashboard-internals`) — why it looks that way.
  Pool, Argon2, SSE, process resources.

Eighteen panels on one page is a scanning problem at exactly the moment you cannot afford one. The
overview answers *whether* something is wrong; internals answers *where*. They cross-link through a
shared `frontdashboard` tag, so each lists the other in its top-right dropdown.

Neither file carries an `__inputs` block. They use a `datasource` template variable instead, so the
panels bind to whichever Prometheus is picked at import time and can be repointed afterwards.

## Loading these into Grafana

Both by hand, from the browser. No token, no API, nothing written to the deployment host.

**Dashboards first** — *Dashboards → New → Import*, paste the JSON, pick the Prometheus data
source. Re-importing the same file updates the existing dashboard rather than adding a second; the
`uid` inside the JSON is what matches them up. Do these before the rules, which link to their panels
by id.

**Alert rules** — *Alerting → Alert rules → Import rules → Prometheus YAML file*, upload
`alerts.yml`, then choose the FrontDashboard folder and the Prometheus data source. Grafana
converts each rule into a Grafana-managed one, which is the whole reason this file is in Prometheus
format: Grafana's own provisioning format can be exported but not imported, so it can only be
loaded as a file inside the container — on the NAS, where the repo cannot reach.

Conversion preserves Prometheus semantics, so a query returning nothing leaves the rule Normal
rather than raising No Data. That matters here: most of these expressions return an empty result
whenever the thing they watch is healthy.

Imported rules stay **editable in the UI**, unlike file-provisioned ones. Try a threshold in the
browser if that is easier, then write the value back here.

**Re-importing updates in place** — every rule pins its identity with a
`__grafana_alert_rule_uid__` label, so the second import edits the same fifteen rules instead of
creating fifteen more. Deletion is still manual: dropping a rule from this file does not remove it
from Grafana, and it will keep firing with nothing left here to explain it.

**Contact points are not in this repo.** They hold a webhook URL or an SMTP password: create one in
*Alerting → Contact points*, then route `severity = critical` to it in *Notification policies*.
That is six of the fifteen rules; the rest stay visible and silent, because fifteen notifications is
how alerting starts being ignored.

## Editing

Change the files here, not the browser. Every query in all three is validated against a live
Prometheus before commit — a panel that renders "No data" because of a typo looks identical to one
whose metric legitimately has no samples yet, so the check is not optional.

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

The probe must leave the host and come back through Cloudflare. Pointing it at an internal address
would test the one path that is already covered.

### Cap the disk, not just the age

The container ships `--storage.tsdb.retention.time=15d` with `retention.size` unset, so runaway
cardinality fills the array rather than evicting. Add to **Extra Parameters** in the Unraid
template:

```
--storage.tsdb.retention.size=5GB
```

Whichever limit is reached first wins, so this only ever acts as a floor under the disk.

### Close the UI back up

`web.config.file` is empty, so `:9090` serves every metric plus 15 days of history to anything on
the LAN with no authentication. That is the same connection-count and activity-volume data that
[`routers/metrics.py`](../backend/app/routers/metrics.py) deliberately keeps off `/api`, so leaving
it open contradicts the reasoning that put it there.

```yaml
# web-config.yml — then add --web.config.file=/etc/prometheus/web-config.yml
basic_auth_users:
  admin: <bcrypt hash — htpasswd -nBC 12 "" | tr -d ':\n'>
```

Grafana's data source then needs the same credentials under **Basic auth**.
