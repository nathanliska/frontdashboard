"""Participants on calendar events: member-validated writes, named reads, series-level."""

from httpx import AsyncClient

from tests.helpers import create_calendar_event, create_dashboard, register_client, set_csrf


async def _join_as(auth_client: AsyncClient, dashboard_id: str, email: str, name: str, role: str = "editor") -> AsyncClient:
    set_csrf(auth_client)
    invite = await auth_client.post(f"/api/dashboards/{dashboard_id}/invites", json={"role": role})
    assert invite.status_code == 201, invite.text
    member = await register_client(email, display_name=name)
    set_csrf(member)
    accepted = await member.post(f"/api/invites/{invite.json()['code']}/accept")
    assert accepted.status_code == 200, accepted.text
    return member


async def _member_id(client: AsyncClient) -> str:
    me = await client.get("/api/auth/me")
    assert me.status_code == 200, me.text
    return me.json()["id"]


async def test_create_names_participants_sorted_and_deduplicated(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client)
    zoe = await _join_as(auth_client, dashboard["id"], "zoe@example.com", "Zoe")
    zoe_id = await _member_id(zoe)
    owner_id = await _member_id(auth_client)

    event = await create_calendar_event(auth_client, dashboard["id"], participants=[zoe_id, owner_id, zoe_id])

    assert [(p["display_name"]) for p in event["participants"]] == ["Test User", "Zoe"]
    assert {p["user_id"] for p in event["participants"]} == {owner_id, zoe_id}
    await zoe.aclose()


async def test_a_non_member_participant_is_a_422(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client)
    stranger = await register_client("stranger@example.com")
    stranger_id = await _member_id(stranger)

    set_csrf(auth_client)
    resp = await auth_client.post(
        "/api/calendar/events",
        json={
            "title": "Dentist",
            "starts_at": "2026-04-10T14:00:00+00:00",
            "ends_at": "2026-04-10T15:00:00+00:00",
            "timezone": "UTC",
            "dashboard_id": dashboard["id"],
            "participants": [stranger_id],
        },
    )
    assert resp.status_code == 422, resp.text

    event = await create_calendar_event(auth_client, dashboard["id"])
    patched = await auth_client.patch(f"/api/calendar/events/{event['id']}", json={"participants": [stranger_id]})
    assert patched.status_code == 422, patched.text
    await stranger.aclose()


async def test_patch_replaces_clears_and_absence_preserves(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client)
    owner_id = await _member_id(auth_client)
    event = await create_calendar_event(auth_client, dashboard["id"], participants=[owner_id])

    set_csrf(auth_client)
    # Absent field: a title-only patch must leave the set alone.
    patched = await auth_client.patch(f"/api/calendar/events/{event['id']}", json={"title": "Renamed"})
    assert [p["user_id"] for p in patched.json()["participants"]] == [owner_id]

    # Explicit empty list clears.
    cleared = await auth_client.patch(f"/api/calendar/events/{event['id']}", json={"participants": []})
    assert cleared.json()["participants"] == []

    restored = await auth_client.patch(f"/api/calendar/events/{event['id']}", json={"participants": [owner_id]})
    assert [p["user_id"] for p in restored.json()["participants"]] == [owner_id]


async def test_participants_ride_every_occurrence_of_a_series(auth_client: AsyncClient) -> None:
    dashboard = await create_dashboard(auth_client)
    owner_id = await _member_id(auth_client)
    await create_calendar_event(
        auth_client,
        dashboard["id"],
        title="Soccer",
        participants=[owner_id],
        recurrence={"frequency": "weekly", "interval": 1, "by_weekday": [4]},
    )

    listing = await auth_client.get(
        "/api/calendar/events",
        params={"window_start": "2026-04-01T00:00:00+00:00", "window_end": "2026-05-01T00:00:00+00:00"},
    )
    assert listing.status_code == 200, listing.text
    soccer = [o for o in listing.json() if o["title"] == "Soccer"]
    assert len(soccer) >= 3
    assert all([p["user_id"] for p in o["participants"]] == [owner_id] for o in soccer)


async def test_an_unshared_member_stays_on_the_event_by_name(auth_client: AsyncClient) -> None:
    """The former-member behavior: revoking access must not silently rewrite history."""
    dashboard = await create_dashboard(auth_client)
    zoe = await _join_as(auth_client, dashboard["id"], "zoe-leaves@example.com", "Zoe")
    zoe_id = await _member_id(zoe)
    event = await create_calendar_event(auth_client, dashboard["id"], participants=[zoe_id])

    shares = await auth_client.get(f"/api/dashboards/{dashboard['id']}/shares")
    share_id = next(s["id"] for s in shares.json() if s["principal_id"] == zoe_id)
    set_csrf(auth_client)
    revoked = await auth_client.delete(f"/api/dashboards/{dashboard['id']}/shares/{share_id}")
    assert revoked.status_code == 204, revoked.text

    fetched = await auth_client.get(f"/api/calendar/events/{event['id']}")
    assert [(p["user_id"], p["display_name"]) for p in fetched.json()["participants"]] == [(zoe_id, "Zoe")]

    # And they are gone from the picker's source, which is what renders them "former".
    members = await auth_client.get(f"/api/dashboards/{dashboard['id']}/members")
    assert zoe_id not in {m["user_id"] for m in members.json()}
    await zoe.aclose()
