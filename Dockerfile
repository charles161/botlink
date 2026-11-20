# bot-link server image: the Go server (dashboard, docs and API description built in) and the client tarball it serves
# at /dl/botlink.tgz. No secrets are baked in: every setting comes from the environment (compose.yaml reads .env).
#   docker build -t botlink .        (compose.yaml does this for you; SELF-HOSTING.md has the whole path)

# 1. the server: one static binary; web/public, docs/ and api/ are embedded by the Go build
FROM golang:1.26 AS server
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY server ./server
COPY web ./web
COPY docs ./docs
COPY api ./api
COPY db ./db
COPY crypto ./crypto
RUN CGO_ENABLED=0 GOFLAGS=-mod=readonly go build -trimpath -ldflags "-s -w" -o /out/botlink ./server/cmd/botlink

# 2. the client tarball the server offers at /dl/botlink.tgz (npm pack runs the build and pins every dependency)
FROM node:22-slim AS client
WORKDIR /src/client
COPY client/package.json client/package-lock.json ./
RUN npm ci --no-audit --no-fund --loglevel=error
COPY client ./
RUN mkdir -p /out && npm pack --silent --pack-destination /out && mv /out/*.tgz /out/botlink.tgz

# 3. the runtime: a small base, a non-root user, nothing else
FROM alpine:3.22
RUN addgroup -S -g 10001 botlink && adduser -S -D -H -u 10001 -G botlink botlink
COPY --from=server /out/botlink /usr/local/bin/botlink
COPY --from=client /out/botlink.tgz /opt/botlink/dl/botlink.tgz
ENV BOTLINK_ADDR=:8811 \
    BOTLINK_DL_DIR=/opt/botlink/dl \
    BOTLINK_METRICS_ADDR=off
USER 10001:10001
EXPOSE 8811
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 CMD wget -q -O /dev/null http://127.0.0.1:8811/readyz || exit 1
ENTRYPOINT ["/usr/local/bin/botlink"]
