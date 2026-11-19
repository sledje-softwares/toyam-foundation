# Processing pipeline worker (D38): one always-on container, provider-neutral. Build from the repository root
# (the worker reuses services/labeller/src and supabase/functions/_shared/r2):
#
#   docker build -f services/pipeline/Dockerfile -t toyam-pipeline .
#   docker run --rm --env-file pipeline.env -p 8080:8080 toyam-pipeline
#
# Only the paths below are sent to the build (services/pipeline/Dockerfile.dockerignore).
FROM node:22.22.1-slim

ENV NODE_ENV=production HEALTH_PORT=8080
WORKDIR /app/services/pipeline

# dependencies first (cached layer); sharp and @napi-rs/canvas ship prebuilt linux-x64 / arm64 binaries
COPY services/pipeline/package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY services/labeller/package.json /app/services/labeller/package.json
COPY services/labeller/src /app/services/labeller/src
COPY supabase/functions/_shared/r2 /app/supabase/functions/_shared/r2
COPY services/pipeline/src ./src

USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HEALTH_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# SIGTERM -> stop claiming, drain running jobs (SHUTDOWN_GRACE_MS), hand the rest back
STOPSIGNAL SIGTERM
CMD ["node", "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "src/main.ts"]
