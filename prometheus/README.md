# Prometheus configuration

Reference copies of what runs on the deployment host. Nothing here is read by the app or by CI —
the repo never reaches that host, so these are hand-synced, the same as the dashboards in
[`grafana/`](../grafana/README.md).

Files live at `/mnt/user/appdata/prometheus/` on Unraid, which is `/etc/prometheus/` inside the
container.

## 1. Load the alert rules

Copy `alerts.yml` next to `prometheus.yml`, then reference it:

```yaml
rule_files:
  - /etc/prometheus/alerts.yml
```

Prometheus evaluates rules but routes nothing. It shows them firing under **Alerts** in its own UI,
which is enough to confirm an expression is correct and not enough to be told at 3am.

To actually be notified, recreate the same expressions as Grafana alert rules — Grafana is already
running, already has the data source, and reaches email/Discord/ntfy through a contact point.
Alertmanager is the other option and is a third container to keep alive; for one instance it is
more moving parts than it earns.

## 2. Watch the site from outside

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

## 3. Cap the disk, not just the age

The container ships `--storage.tsdb.retention.time=15d` with `retention.size` unset, so runaway
cardinality fills the array rather than evicting. Add to **Extra Parameters** in the Unraid
template:

```
--storage.tsdb.retention.size=5GB
```

Whichever limit is reached first wins, so this only ever acts as a floor under the disk.

## 4. Close the UI back up

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
