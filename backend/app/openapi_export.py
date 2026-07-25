"""Export the OpenAPI schema for frontend contract generation (`make contracts`).

Not imported by the running app — this is the build-time half of the contract pipeline
described in CLAUDE.md. Run it with `python -m app.openapi_export`.

The one transformation applied on the way out is `const` -> `enum`: Pydantic v2 renders a
single-value `Literal` as JSON Schema `{"const": "clock"}`, and typed-openapi (the zod
generator) ignores `const`, degrading every discriminator to a plain `z.string()`. A
single-member `enum` is an equivalent constraint that it does emit as `z.literal('clock')`,
which is what makes the generated widget union actually narrow on the frontend. Both keywords
are kept so the exported document stays faithful for any other consumer.
"""

from __future__ import annotations

import json
import sys
from typing import Any


def widen_const_to_enum(node: Any) -> Any:
    """Recursively add a single-member `enum` next to every `const`.

    Returns a new structure; the input is not mutated.
    """
    if isinstance(node, dict):
        result = {key: widen_const_to_enum(value) for key, value in node.items()}
        if "const" in result and "enum" not in result:
            result["enum"] = [result["const"]]
        return result
    if isinstance(node, list):
        return [widen_const_to_enum(item) for item in node]
    return node


def build_schema() -> dict[str, Any]:
    # Imported lazily: app.main pulls in Settings, which requires a populated environment.
    from app.main import app

    return widen_const_to_enum(app.openapi())


def main() -> None:
    destination = sys.argv[1] if len(sys.argv) > 1 else "openapi.json"
    with open(destination, "w", encoding="utf-8") as handle:
        json.dump(build_schema(), handle, indent=2, sort_keys=True)
        handle.write("\n")


if __name__ == "__main__":
    main()
