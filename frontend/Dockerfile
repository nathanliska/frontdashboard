# Node 22 to match CI and Dockerfile.prod — react-router 8 requires >=22.22.0.
FROM node:25-alpine

WORKDIR /app

COPY package*.json ./
# `npm ci` to match Dockerfile.prod and the lockfile; the cache purge is in the same layer
# because a later `RUN rm` would only mask ~118MB of /root/.npm, not remove it from the image.
# node_modules still has to be built here — compose seeds the frontend-node-modules volume from it.
RUN npm ci && npm cache clean --force

COPY . .

EXPOSE 5173

CMD ["npm", "run", "dev"]
