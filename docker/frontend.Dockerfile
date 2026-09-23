# Builds the SPA plus the nginx that serves it and proxies the API. Build
# context: the repository root (see docker-compose.yml).
#
# LINEOS_BASE is the subpath: "/" (the default) or e.g. "/lineos/". It has to
# be fixed at build time -- Vite rewrites the asset URLs -- and nginx reads the
# same value at startup to lay out its locations.
ARG LINEOS_BASE=/

FROM node:22-alpine AS build
ARG LINEOS_BASE
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html vite.config.js ./
COPY public ./public
COPY src ./src
ENV VITE_BASE=$LINEOS_BASE
RUN npm run build

FROM nginx:1.27-alpine
ARG LINEOS_BASE
ENV LINEOS_BASE=$LINEOS_BASE
# Only the LINEOS_* variables are substituted; nginx's own $uri, $host... stay.
ENV NGINX_ENVSUBST_FILTER=^LINEOS_
RUN rm /etc/nginx/conf.d/default.conf
COPY docker/lineos-base.envsh /docker-entrypoint.d/05-lineos-base.envsh
RUN chmod +x /docker-entrypoint.d/05-lineos-base.envsh
COPY docker/frontend-nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html${LINEOS_BASE}
