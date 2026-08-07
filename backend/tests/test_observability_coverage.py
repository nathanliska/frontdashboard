"""Every metric a dashboard or alert names still exists in the code.

Renaming a metric is a one-line edit that breaks a panel silently: Grafana renders "No data",
which is indistinguishable from a metric that legitimately has no samples yet. The alert case is
worse — a rule whose series vanished evaluates to nothing and stays quiet forever, so the rename
disables the alert rather than breaking it. This makes both a build failure instead.

The reverse direction is deliberately not asserted: some metrics exist for a future query or are
only useful as one side of a ratio, so "exposed but unplotted" is a valid state.
"""

import json
import re
from pathlib import Path

from prometheus_client import REGISTRY

# Importing the router is what registers the scrape-time gauges; app.metrics alone would miss them.
import app.routers.metrics  # noqa: F401

_REPO = Path(__file__).resolve().parents[2]
_DASHBOARDS = sorted((_REPO / "observability" / "dashboards").glob("*.json"))
_ALERTS = _REPO / "observability" / "alerts.yml"

# A counter's samples end in `_total`, a histogram's in `_bucket`/`_sum`/`_count`, but the metric
# family is registered under the bare name. Queries name the sample, so both forms have to resolve.
_SAMPLE_SUFFIXES = ("_bucket", "_count", "_sum", "_total")

_METRIC_REFERENCE = re.compile(r"\bfrontdashboard_\w+\b")

# The two keys are always written adjacent, which is what lets this pair them without a YAML parser.
_PANEL_LINK = re.compile(r'__dashboardUid__:\s*(\S+)\s*\n\s*__panelId__:\s*"(\d+)"')


def _exposed_metric_names() -> set[str]:
    """Every metric family the app registers, by family name."""
    return {metric.name for metric in REGISTRY.collect() if metric.name.startswith("frontdashboard_")}


def _referenced_metric_names() -> dict[str, set[str]]:
    """Metric names each observability file mentions, keyed by the file's repo-relative path."""
    found: dict[str, set[str]] = {}
    for path in [*_DASHBOARDS, _ALERTS]:
        text = path.read_text()
        # Both are structured text, but only metric names are needed, so a regex over the raw
        # bytes avoids a YAML parser as a test dependency.
        names = set(_METRIC_REFERENCE.findall(text))
        if names:
            found[str(path.relative_to(_REPO))] = names
    return found


def _resolves(name: str, exposed: set[str]) -> bool:
    if name in exposed:
        return True
    return any(name.endswith(suffix) and name[: -len(suffix)] in exposed for suffix in _SAMPLE_SUFFIXES)


def test_observability_files_are_present() -> None:
    """A vacuous pass is the failure mode this whole module exists to avoid."""
    assert _DASHBOARDS, "no dashboards found — this test would pass having checked nothing"
    assert _ALERTS.is_file(), f"{_ALERTS} is missing"


def test_every_referenced_metric_exists() -> None:
    exposed = _exposed_metric_names()
    assert exposed, "no frontdashboard_* metrics registered; the import above did not take effect"

    unknown = {source: sorted(name for name in names if not _resolves(name, exposed)) for source, names in _referenced_metric_names().items()}
    unknown = {source: names for source, names in unknown.items() if names}
    assert not unknown, f"metrics named but not registered: {unknown}"


def test_alert_panel_links_resolve() -> None:
    """An alert's "go to panel" button is followed under pressure, so a dead one costs real time."""
    panels = {(doc["uid"], panel["id"]) for doc in (json.loads(path.read_text()) for path in _DASHBOARDS) for panel in doc["panels"]}
    linked = {(uid, int(panel_id)) for uid, panel_id in _PANEL_LINK.findall(_ALERTS.read_text())}
    assert linked, "no alert links a panel — this test would pass having checked nothing"
    assert not linked - panels, f"alerts link panels that do not exist: {sorted(linked - panels)}"


# Route is a template drawn from the router table, so these two cannot enumerate their children up
# front. `http_server_errors` is the unlabelled twin that keeps the 5xx case alertable regardless.
_LAZY_BY_DESIGN = {"frontdashboard_http_responses", "frontdashboard_http_request_seconds"}


def test_labelled_metrics_pre_create_their_children() -> None:
    """A labelled child is created on first use, so its first sample is already 1.

    `increase()` and `rate()` then have nothing to diff against and report 0 through the very event
    the metric exists to catch — for a histogram, the quantiles resolve to NaN instead. Every family
    with a bounded label set therefore names its children at import; this fails the build when a new
    one forgets. Empty families are the tell, since an unlabelled metric always emits a sample.
    """
    empty = {metric.name for metric in REGISTRY.collect() if metric.name.startswith("frontdashboard_") and not metric.samples}

    assert not empty - _LAZY_BY_DESIGN, f"labelled metrics with no pre-created children: {sorted(empty - _LAZY_BY_DESIGN)}"


def test_dashboards_parse_and_declare_a_datasource_variable() -> None:
    """Panels need something to bind to, and `__inputs` makes that a prompt instead of a variable."""
    for path in _DASHBOARDS:
        doc = json.loads(path.read_text())
        assert "__inputs" not in doc, f"{path.name} carries __inputs, which makes import a prompt"
        kinds = {var.get("type") for var in doc.get("templating", {}).get("list", [])}
        assert "datasource" in kinds, f"{path.name} has no datasource variable to bind panels to"
