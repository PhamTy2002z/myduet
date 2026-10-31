import { readFileSync } from "node:fs";
import { createBridge } from "./bridge";
import { parseRoutes } from "./routes";

// Compose passes unset optionals as empty strings; blank means unset.
const env = (name: string) => process.env[name]?.trim() || undefined;

const routesFile = env("HERMES_ROUTES_FILE");
if (!routesFile) {
  console.error(
    "HERMES_ROUTES_FILE is not set. It names the JSON file of coworker routes (see README.md).",
  );
  process.exit(1);
}

let routes: ReturnType<typeof parseRoutes>;
try {
  routes = parseRoutes(readFileSync(routesFile, "utf8"));
} catch (error) {
  console.error(
    `The routes file could not be used: ${error instanceof Error ? error.message : error}`,
  );
  process.exit(1);
}

const port = Number.parseInt(env("PORT") ?? "4230", 10);
const bridge = createBridge({
  routes,
  toolUrl:
    env("OPENBOT_TOOL_URL") ?? "http://127.0.0.1:3001/api/agent-tools/call",
  mcpServer: env("HERMES_MCP_SERVER_NAME") ?? "openbot",
  dataDir: env("HERMES_BRIDGE_DATA_DIR") ?? ".agent-hermes",
});
const server = Bun.serve({
  port,
  hostname: env("BIND_HOST") ?? "0.0.0.0",
  // Streams carry their own heartbeat; Bun's default 10 s idle limit would cut a quiet one.
  idleTimeout: 255,
  fetch: bridge,
});
console.info(
  `agent-hermes: ${routes.length} coworker route(s) on http://${server.hostname}:${server.port}`,
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    server.stop();
    // Hermes turns keep running when their stream closes; stop them rather than leave them unwatched.
    await bridge.stopAll();
    process.exit(0);
  });
}
