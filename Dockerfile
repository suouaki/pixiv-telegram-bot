FROM node:20-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY bot.ts tsconfig.json ./
RUN npm run build

FROM node:20-alpine AS runtime

RUN apk add --no-cache ffmpeg \
	&& mkdir -p /app/data /app/temp \
	&& chown -R node:node /app

WORKDIR /app
ENV NODE_ENV=production
ENV DATA_DIR=/app/data

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build --chown=node:node /app/dist ./dist

USER node
CMD ["node", "dist/bot.js"]
