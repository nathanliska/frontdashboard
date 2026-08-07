# Kept in step with .nvmrc and Dockerfile.prod by test_toolchain_coverage.py.
# react-router 8 requires >=22.22.0.
FROM node:26-alpine

WORKDIR /app

# Paths are root-relative because the context is the repo root, as Dockerfile.prod's is.
COPY frontend/package*.json ./
# `npm ci` to match Dockerfile.prod and the lockfile; the cache purge is in the same layer
# because a later `RUN rm` would only mask ~118MB of /root/.npm, not remove it from the image.
# node_modules still has to be built here — compose seeds the frontend-node-modules volume from it.
RUN npm ci && npm cache clean --force

COPY frontend/ .

EXPOSE 5173

CMD ["npm", "run", "dev"]
