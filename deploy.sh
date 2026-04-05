#!/usr/bin/env bash
set -euo pipefail

DOCKER_USER="heatslinger"
BACKEND_IMAGE="${DOCKER_USER}/frontdashboard-backend"
FRONTEND_IMAGE="${DOCKER_USER}/frontdashboard-frontend"
TAG="${1:-latest}"

echo "==> Building backend image..."
docker build \
    -t "${BACKEND_IMAGE}:${TAG}" \
    -f backend/Dockerfile.prod \
    backend/

echo "==> Building frontend image..."
docker build \
    -t "${FRONTEND_IMAGE}:${TAG}" \
    -f frontend/Dockerfile.prod \
    .

echo "==> Pushing images to Docker Hub..."
docker push "${BACKEND_IMAGE}:${TAG}"
docker push "${FRONTEND_IMAGE}:${TAG}"

echo "==> Done. Images pushed:"
echo "    ${BACKEND_IMAGE}:${TAG}"
echo "    ${FRONTEND_IMAGE}:${TAG}"
echo ""
echo "On Unraid, run:"
echo "    docker compose --env-file .env.prod -f docker-compose.prod.yml pull"
echo "    docker compose --env-file .env.prod -f docker-compose.prod.yml up -d"
