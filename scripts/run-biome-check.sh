#!/usr/bin/env bash

set -euo pipefail

cd frontend

files=()
for file in "$@"; do
  files+=("${file#frontend/}")
done

npm exec -- biome check --write --no-errors-on-unmatched --files-ignore-unknown=true "${files[@]}"
