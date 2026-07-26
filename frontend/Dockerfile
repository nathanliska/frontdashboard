# Node 22 to match CI and Dockerfile.prod — react-router 8 requires >=22.22.0.
FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 5173

CMD ["npm", "run", "dev"]
