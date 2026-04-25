import uuid
from typing import Any, cast


def _preferences_dict(preferences: object) -> dict[str, Any]:
    return cast(dict[str, Any], preferences).copy() if isinstance(preferences, dict) else {}


def favorite_dashboard_id_strings_from_preferences(preferences: object) -> list[str]:
    raw_values = _preferences_dict(preferences).get("favorite_dashboard_ids")
    if not isinstance(raw_values, list):
        return []

    normalized_ids: list[str] = []
    seen: set[str] = set()
    for value in raw_values:
        if not isinstance(value, str):
            continue
        try:
            normalized = str(uuid.UUID(value))
        except ValueError:
            continue
        if normalized in seen:
            continue
        seen.add(normalized)
        normalized_ids.append(normalized)
    return normalized_ids


def favorite_dashboard_ids_from_preferences(preferences: object) -> list[uuid.UUID]:
    return [uuid.UUID(value) for value in favorite_dashboard_id_strings_from_preferences(preferences)]


def remove_dashboard_from_preferences(preferences: object, dashboard_id: uuid.UUID) -> dict[str, Any]:
    normalized_preferences = _preferences_dict(preferences)
    dashboard_id_string = str(dashboard_id)

    if normalized_preferences.get("home_dashboard_id") == dashboard_id_string:
        normalized_preferences["home_dashboard_id"] = None

    favorite_dashboard_ids = [
        favorite_id for favorite_id in favorite_dashboard_id_strings_from_preferences(normalized_preferences) if favorite_id != dashboard_id_string
    ]
    if favorite_dashboard_ids or "favorite_dashboard_ids" in normalized_preferences:
        normalized_preferences["favorite_dashboard_ids"] = favorite_dashboard_ids

    return normalized_preferences
