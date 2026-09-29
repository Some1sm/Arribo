# Stage 1: minified copies of the browser JS/CSS (the repository keeps the readable sources).
# The copy lives in dist/public because minify_public.js refuses the public/ next to it.
FROM node:22.19.0-alpine@sha256:d2166de198f26e17e5a442f537754dd616ab069c47cc57b889310a717e0abbf9 AS assets
WORKDIR /build
COPY package*.json ./
RUN npm ci
COPY scripts/minify_public.js ./scripts/minify_public.js
COPY public ./dist/public
RUN node scripts/minify_public.js dist/public

# Stage 2: runtime. Node 22 Alpine for minimal footprint and native node:sqlite support
FROM node:22.19.0-alpine@sha256:d2166de198f26e17e5a442f537754dd616ab069c47cc57b889310a717e0abbf9

# Set working directory
WORKDIR /app

# Set environment
ENV NODE_ENV=production
ENV PORT=3000
ENV NODE_OPTIONS="--max-old-space-size=160 --expose-gc"

# Copy package manifests first for efficient caching
COPY package*.json ./

# Install production dependencies
RUN npm ci --omit=dev

# Copy application source code
COPY . .

# Serve the minified browser JS/CSS built in the assets stage
COPY --from=assets /build/dist/public/js ./public/js
COPY --from=assets /build/dist/public/css ./public/css

# Ensure data directory exists; make /app writable by the non-root node user
RUN mkdir -p /app/data && chown -R node:node /app

# Run as the non-root user shipped with official node images
USER node

# Expose HTTP port
EXPOSE 3000

# Container-level health check (mirrors docker-compose.yml healthcheck)
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=15s \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1

# Start server (heap setting carried by NODE_OPTIONS env, size optimization via CLI argument)
CMD ["node", "--optimize-for-size", "server.js"]
