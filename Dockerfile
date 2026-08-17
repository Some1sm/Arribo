# Use Node 22 Alpine for minimal footprint and native node:sqlite support
FROM node:22-alpine

# Set working directory
WORKDIR /app

# Set environment
ENV NODE_ENV=production
ENV PORT=3000
ENV NODE_OPTIONS="--max-old-space-size=256 --optimize-for-size"

# Copy package manifests first for efficient caching
COPY package*.json ./

# Install production dependencies
RUN npm ci --omit=dev || npm install --omit=dev

# Copy application source code
COPY . .

# Ensure data and cache directories exist
RUN mkdir -p /app/data /app/data/cache

# Expose HTTP port
EXPOSE 3000

# Start server
CMD ["node", "server.js"]
