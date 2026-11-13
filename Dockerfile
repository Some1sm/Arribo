# Stage 1: minified copies of the browser JS/CSS (the repository keeps the readable sources).
# The copy lives in dist/public because minify_public.js refuses the public/ next to it.
FROM node:22.23.4-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS assets
WORKDIR /build
COPY package*.json ./
RUN npm ci
COPY scripts/minify_public.js ./scripts/minify_public.js
COPY public ./dist/public
RUN node scripts/minify_public.js dist/public

# Stage 2: the server, one static binary (app/; pure Go SQLite, no cgo).
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY app/go.mod app/go.sum ./
RUN go mod download
COPY app/ ./
RUN CGO_ENABLED=0 GOAMD64=v1 go build -trimpath -ldflags="-s -w" -o /out/arribo . \
 && mkdir -p /rootfs/tmp && chmod 1777 /rootfs/tmp

# Stage 3: runtime. No shell, no package manager: the binary, the CA bundle
# (photon.komoot.io; the Avanza chain is vendored in src/data/certs) and the
# files the server reads. Time zone data is compiled into the binary.
FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /rootfs/ /
WORKDIR /app
# data/ is the volume in production; the image carries what Node's did (see .dockerignore).
COPY --chown=1000:1000 data ./data
COPY package.json ./
COPY src/data ./src/data
COPY public ./public
COPY --from=assets /build/dist/public/js ./public/js
COPY --from=assets /build/dist/public/css ./public/css
COPY --from=build /out/arribo ./arribo

ENV PORT=3000 TZ=Europe/Madrid ARRIBO_ROOT=/app
# Same uid as the node user of the previous image, so data/ keeps working.
USER 1000:1000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=15s \
  CMD ["/app/arribo", "healthcheck"]

ENTRYPOINT ["/app/arribo"]
