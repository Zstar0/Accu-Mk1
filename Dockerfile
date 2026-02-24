# ============================================================
# Accu-Mk1 Frontend — Multi-stage build
# Stage 1: Build the Vite/React app
# Stage 2: Serve static files with Nginx
# ============================================================

# --- Stage 1: Build ---
FROM node:20-slim AS build

# Which env file to bake into the frontend bundle.
# Default: .env.docker (local Docker dev — SENAITE on localhost:8080)
# Production: docker build --build-arg ENV_FILE=.env.docker.prod .
ARG ENV_FILE=.env.docker

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

# Copy our custom nginx config
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy built assets from stage 1
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
