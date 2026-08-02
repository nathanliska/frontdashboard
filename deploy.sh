#!/usr/bin/env bash
set -euo pipefail

DOCKER_USER="heatslinger"
BACKEND_IMAGE="${DOCKER_USER}/frontdashboard-backend"
FRONTEND_IMAGE="${DOCKER_USER}/frontdashboard-frontend"
TAG="${1:-latest}"

# Every deploy moves the mutable tag, which leaves the build it replaced unnamed and eligible for
# garbage collection. The immutable sha tag is the rollback target: pin it in the Unraid compose
# and restart, instead of rebuilding from an older commit while the site is down (#34).
SHA="$(git rev-parse --short HEAD)"

if [[ -n "$(git status --porcelain)" && "${ALLOW_DIRTY:-0}" != "1" ]]; then
    echo "Refusing to deploy: the working tree is dirty, so :${SHA} would not describe what is in" >&2
    echo "the image — and a rollback target that lies is worse than none. Commit, or ALLOW_DIRTY=1." >&2
    exit 1
fi

echo "==> Building backend image..."
docker build \
    -t "${BACKEND_IMAGE}:${TAG}" \
    -t "${BACKEND_IMAGE}:${SHA}" \
    -f backend/Dockerfile.prod \
    backend/

echo "==> Building frontend image..."
docker build \
    -t "${FRONTEND_IMAGE}:${TAG}" \
    -t "${FRONTEND_IMAGE}:${SHA}" \
    -f frontend/Dockerfile.prod \
    .

echo "==> Pushing images to Docker Hub..."
for image in "${BACKEND_IMAGE}" "${FRONTEND_IMAGE}"; do
    docker push "${image}:${TAG}"
    # Shares every layer with the push above, so this costs a manifest and nothing else.
    if [[ "${TAG}" != "${SHA}" ]]; then
        docker push "${image}:${SHA}"
    fi
done

echo "==> Done. Images pushed:"
echo "    ${BACKEND_IMAGE}:${TAG}  (and :${SHA})"
echo "    ${FRONTEND_IMAGE}:${TAG}  (and :${SHA})"
echo ""
echo "On Unraid, run:"
echo "    docker compose --env-file .env.prod -f docker-compose.prod.yml pull"
echo "    docker compose --env-file .env.prod -f docker-compose.prod.yml up -d"
echo ""
echo "To roll back, pin ${SHA} (or an earlier one) in the compose file:"
echo "    docs/runbooks/rollback.md"
