# Builds the SPA plus the nginx that serves it under /flow-editor/ and proxies
# the API. Build context: the repository root (see docker-compose.yml).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html vite.config.js ./
COPY src ./src
# The subpath has to be fixed at build time: Vite rewrites the asset URLs.
ENV VITE_BASE=/flow-editor/
RUN npm run build

FROM nginx:1.27-alpine
COPY docker/frontend-nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html/flow-editor
