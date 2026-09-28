FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:24-bookworm-slim
ENV NODE_ENV=production MCP_HTTP_HOST=0.0.0.0 MCP_HTTP_PORT=8788 INSTAGRAM_DATABASE_PATH=/data/state.sqlite
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8788
CMD ["node", "dist/cli.js", "http"]
