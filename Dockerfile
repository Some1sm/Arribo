# Use Node 22 Alpine for minimal footprint and native node:sqlite support
FROM node:22-alpine

# Set working directory
WORKDIR /app

# Set environment
ENV NODE_ENV=production
ENV PORT=3000
ENV NODE_OPTIONS="--max-old-space-size=256"

# Copy package manifests first for efficient caching
COPY package*.json ./

# Install production dependencies
RUN npm ci --omit=dev || npm install --omit=dev

# Copy application source code
COPY . .

# Ensure data and cache directories exist; make /app writable by the non-root node user
RUN mkdir -p /app/data /app/data/cache && chown -R node:node /app

# Run as the non-root user shipped with official node images
USER node

# Expose HTTP port
EXPOSE 3000

# Container-level health check (mirrors docker-compose.yml healthcheck)
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=15s \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1

# Start server (heap setting carried by NODE_OPTIONS env)
CMD ["node", "server.js"]
