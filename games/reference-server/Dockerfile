# One Fly machine per world (docs/plan/38-hosting-checks.md). Build context: this directory after
# `node scripts/stage-image.mjs` (it fills `.stage/`; `.dockerignore` admits nothing else).
FROM node:22-slim
WORKDIR /app
# `ws` is the server's one dependency; the engine package is copied in as `node_modules/engine`.
RUN npm install --no-audit --no-fund ws@8.18.3
COPY .stage/ /app/
ENV PORT=8080
ENV HOST=0.0.0.0
EXPOSE 8080
# `--data` is the volume (fly.toml `[[mounts]]`), `--static` the built client, `--exit-on-idle` makes
# the machine stop 30 s after the last player leaves (autostart wakes it on the next dial).
CMD ["node", "games/reference-server/index.mjs", "--data", "/data", "--static", "/app/client", "--exit-on-idle", "--stats-every", "10"]
