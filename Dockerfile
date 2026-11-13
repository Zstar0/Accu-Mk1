# ============================================================
# Accu-Mk1 Frontend — Multi-stage build
# Stage 1: Build the Vite/React app
# Stage 2: Serve static files with Nginx
# ============================================================

# --- Stage 1: Build ---
FROM node:20-slim AS build

# Which env file to bake into the frontend bundle.
# Default: .env.docker.prod (production — safe default to prevent dev URLs in prod)
# Local dev: docker build --build-arg ENV_FILE=.env.docker .
ARG ENV_FILE=.env.docker.prod

WORKDIR /app

# Copy package files first for better layer caching
COPY package.json package-lock.json ./
RUN npm ci

# Copy source code (excluding backend, see .dockerignore)
COPY . .

# Use the Docker-specific env vars (relative /api path for Nginx proxy)
COPY ${ENV_FILE} .env.production

# Build production bundle — Vite reads .env.production for VITE_* vars
RUN npm run build

# --- Stage 2: Serve ---
FROM nginx:alpine

# Remove default nginx config
RUN rm /etc/nginx/conf.d/default.conf

# Copy our custom nginx config as a template: the image entrypoint envsubsts
# defined env vars into conf.d/default.conf at start (only MK1_EMBED_FRAME_ANCESTORS
# is meant to match; nginx's own $vars are not env vars and pass through).
COPY nginx.conf /etc/nginx/templates/default.conf.template

# Origins allowed to frame /embed.html. Fail closed; compose sets the real one.
ENV MK1_EMBED_FRAME_ANCESTORS="'none'"

# Copy built assets from stage 1
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
