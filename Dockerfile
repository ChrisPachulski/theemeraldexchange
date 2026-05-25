FROM node:24-alpine

WORKDIR /app

# better-sqlite3 (added with iptv) has no prebuilt binary for node 24 on
# Alpine yet, so npm ci falls back to node-gyp. Install the toolchain
# once at the top of the image so the rebuild succeeds; ~50 MB cost.
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci

COPY server ./server
COPY tsconfig.json ./

# Bind-mount target for the grab-event log. Created here so a fresh
# host directory still has the right ownership inside the container.
RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

CMD ["npm", "start"]
