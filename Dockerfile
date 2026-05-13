FROM node:24-alpine

WORKDIR /app

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
