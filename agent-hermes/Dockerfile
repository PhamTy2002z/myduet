# The Hermes bridge has no runtime dependencies: its devDependencies are only for its tests.
FROM oven/bun:1.4-alpine
WORKDIR /app
COPY agent-hermes/src ./agent-hermes/src
# Owned by the user the bridge runs as, before VOLUME: a named volume copies this ownership, and a
# root-owned /data would refuse the tool catalog's first write.
RUN mkdir -p /data && chown bun:bun /data
ENV PORT=4230 HERMES_BRIDGE_DATA_DIR=/data NODE_ENV=production
VOLUME /data
EXPOSE 4230
USER bun
CMD ["bun", "agent-hermes/src/index.ts"]
