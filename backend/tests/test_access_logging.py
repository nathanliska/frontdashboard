"""Above `debug`, the access log drops healthy probe traffic and keeps everything else."""

import logging

import pytest

from app.config import settings
from app.main import ProbeAccessFilter, _configure_app_logging


@pytest.fixture(autouse=True)
def _serving_level(monkeypatch: pytest.MonkeyPatch) -> None:
    """Every case below describes the serving level; `debug` gets its own tests."""
    monkeypatch.setattr(settings, "log_level", "INFO")


def access_record(path: str, status: int) -> logging.LogRecord:
    """Build the record uvicorn's access logger emits for one request."""
    return logging.LogRecord(
        name="uvicorn.access",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg='%s - "%s %s HTTP/%s" %d',
        args=("127.0.0.1:1234", "GET", path, "1.1", status),
        exc_info=None,
    )


@pytest.mark.parametrize("path", ["/api/health", "/api/health/ready", "/metrics"])
def test_successful_probes_are_dropped(path: str) -> None:
    assert ProbeAccessFilter().filter(access_record(path, 200)) is False


# 400 is the boundary itself: without it, narrowing the rule to `> 400` passes every other case.
@pytest.mark.parametrize("status", [400, 401, 500, 503])
def test_a_probe_that_stops_answering_is_kept(status: int) -> None:
    """The whole point of the filter: silence is only for the healthy case."""
    assert ProbeAccessFilter().filter(access_record("/api/health/ready", status)) is True


def test_real_traffic_is_kept() -> None:
    assert ProbeAccessFilter().filter(access_record("/api/lists", 200)) is True


def test_a_probe_path_is_matched_without_its_query_string() -> None:
    assert ProbeAccessFilter().filter(access_record("/metrics?format=text", 200)) is False


def test_a_path_merely_starting_with_a_probe_path_is_kept() -> None:
    """Substring matching here would silence real routes that share the prefix."""
    assert ProbeAccessFilter().filter(access_record("/api/health/ready/detail", 200)) is True
    assert ProbeAccessFilter().filter(access_record("/metrics-admin", 200)) is True


@pytest.mark.parametrize(
    "args",
    [
        None,
        ("only", "three", "args"),
        ("127.0.0.1:1234", "GET", None, "1.1", 200),
        ("127.0.0.1:1234", "GET", "/metrics", "1.1", "200"),
    ],
)
def test_an_unrecognised_record_shape_is_kept(args: tuple[object, ...] | None) -> None:
    """Fail open: a line we cannot parse is still a line, and dropping it hides traffic."""
    record = access_record("/metrics", 200)
    record.args = args
    assert ProbeAccessFilter().filter(record) is True


def test_importing_the_app_attaches_the_filter_to_uvicorns_access_logger() -> None:
    """The unit above proves the rule; this proves it is wired to the logger that emits."""
    access_logger = logging.getLogger("uvicorn.access")
    assert sum(isinstance(f, ProbeAccessFilter) for f in access_logger.filters) == 1
    # Reconfiguring must not stack a second copy — uvicorn --reload re-imports the module.
    _configure_app_logging()
    assert sum(isinstance(f, ProbeAccessFilter) for f in access_logger.filters) == 1


@pytest.mark.parametrize("level", ["debug", "DEBUG"])
def test_debug_keeps_the_probe_lines(level: str, monkeypatch: pytest.MonkeyPatch) -> None:
    """The escape hatch: LOG_LEVEL=debug brings them back with no code change."""
    monkeypatch.setattr(settings, "log_level", level)
    assert ProbeAccessFilter().filter(access_record("/api/health/ready", 200)) is True


def test_an_unreadable_level_serves_quietly(monkeypatch: pytest.MonkeyPatch) -> None:
    """A typo must not turn the access log verbose — fall back the way the app logger does."""
    monkeypatch.setattr(settings, "log_level", "verbose-please")
    assert ProbeAccessFilter().filter(access_record("/metrics", 200)) is False
