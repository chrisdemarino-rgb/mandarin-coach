# Mandarin coach: one Node 20 service serving the static frontend (public/) and the API (server/).
# Primary host: Render (Docker web service + persistent disk at /data; see render.yaml, README-DEPLOY.md).
# Also runs anywhere Docker runs:
#   docker build -t mandarin-coach .
#   docker run -p 8080:8080 -v coach-data:/data --env-file .env mandarin-coach
# Render injects $PORT (default 10000); the app reads it (default 8080). Do not hard-code PORT here.
# The entrypoint fixes ownership of the mounted disk (often root-owned) and then drops to the "node" user.

FROM node:20-bookworm-slim AS deps
WORKDIR /app
# better-sqlite3 is a native module. It normally installs a prebuilt linux-x64 (glibc) binary; the
# compiler toolchain below is only the fallback if no prebuilt matches (e.g. an arm64 build machine).
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-bookworm-slim
ENV NODE_ENV=production \
    DATA_DIR=/data
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
# Everything else (server/, shared/, public/, ...) minus what .dockerignore excludes (node_modules, data, .env).
COPY . .
# public/shared is a symlink to ../shared in the repo; some uploaders drop symlinks, so make it a real copy.
RUN chmod +x /app/docker-entrypoint.sh && rm -rf public/shared && cp -r shared public/shared \
    && mkdir -p /data && chown -R node:node /data /app
# Start as root only so the entrypoint can chown the mounted /data, then it drops to user "node".
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "server/index.js"]
