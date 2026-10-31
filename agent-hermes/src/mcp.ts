/**
 * The MCP server Hermes profiles use for every side effect: myduet's governed tools.
 *
 * Hermes runs its own tool loop and ignores tools a caller sends with a request, so myduet's tools
 * reach it the one way it accepts: as a remote MCP server. Each call goes back through myduet's
 * `/api/agent-tools/call` with the coworker's callback token and the live run's signed assertion, so
 * the grant, the policy and the audit row apply exactly as they do for myduet's own Bots.
 *
 * Hermes loads a server's tool list when it connects and again on `notifications/tools/list_changed`,
 * and an agent sees the list as of its next build (normally the next turn). So `tools/list` answers
 * with every governed tool this coworker has been offered so far (the catalog, kept on disk), and the
 * notification goes out when a run brings a new one. Whether a call is allowed is decided by the live
 * run's own tools, never by the catalog.
 *
 * Streamable HTTP: JSON answers to POST, and a GET stream that carries only the notification.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Route } from "./routes";
import type { RunSlots, ToolDefinition } from "./runs";

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
};

export type ToolCaller = (
  route: Route,
  assertion: string,
  name: string,
  args: Record<string, unknown>,
) => Promise<string>;

/** myduet's governed tool callback, answered the way agent-langgraph answers its model. */
export function governedToolCaller(toolUrl: string): ToolCaller {
  return async (route, assertion, name, args) => {
    try {
      const response = await fetch(toolUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-openbot-agent-token": route.toolToken,
        },
        body: JSON.stringify({ name, args, run: assertion }),
      });
      if (!response.ok) {
        const refusal = (await response.json().catch(() => null)) as {
          error?: unknown;
        } | null;
        const reason =
          typeof refusal?.error === "string" && refusal.error.trim()
            ? ` ${refusal.error.trim()}`
            : "";
        return `Refused. Tool callback returned HTTP ${response.status}.${reason}`;
      }
      const body = (await response.json()) as { text?: string };
      return body.text ?? "The tool returned nothing.";
    } catch (error) {
      return `That tool could not be called: ${error instanceof Error ? error.message : "unknown error"}`;
    }
  };
}

const isFailure = (text: string) =>
  text.startsWith("Refused.") ||
  text.startsWith("That tool could not be called");

/**
 * Every governed tool each coworker has been offered, so a Hermes profile that connects between runs
 * still sees them. Kept in `dataDir` when one is given, so a bridge restart does not empty it.
 */
export class ToolCatalog {
  #tools = new Map<string, Map<string, ToolDefinition>>();
  #listeners = new Map<string, Set<() => void>>();
  constructor(private readonly dataDir?: string) {
    if (dataDir) mkdirSync(dataDir, { recursive: true });
  }

  list(routeId: string): ToolDefinition[] {
    return [...this.#load(routeId).values()];
  }

  /** Adds or updates this run's tools; tells connected profiles when the list changed. */
  remember(routeId: string, tools: ToolDefinition[]): void {
    const known = this.#load(routeId);
    let changed = false;
    for (const tool of tools) {
      const before = known.get(tool.name);
      if (!before || JSON.stringify(before) !== JSON.stringify(tool)) {
        known.set(tool.name, tool);
        changed = true;
      }
    }
    if (!changed) return;
    if (this.dataDir) {
      // Written beside and renamed over, so a crash mid-write never leaves half a file to load.
      const file = this.#file(routeId);
      writeFileSync(`${file}.tmp`, JSON.stringify([...known.values()]));
      renameSync(`${file}.tmp`, file);
    }
    for (const notify of this.#listeners.get(routeId) ?? []) notify();
  }

  subscribe(routeId: string, notify: () => void): () => void {
    const set = this.#listeners.get(routeId) ?? new Set();
    set.add(notify);
    this.#listeners.set(routeId, set);
    return () => set.delete(notify);
  }

  #file(routeId: string) {
    return join(this.dataDir ?? "", `tools-${routeId}.json`);
  }

  #load(routeId: string): Map<string, ToolDefinition> {
    let known = this.#tools.get(routeId);
    if (known) return known;
    known = new Map();
    if (this.dataDir) {
      try {
        for (const tool of JSON.parse(
          readFileSync(this.#file(routeId), "utf8"),
        ) as ToolDefinition[]) {
          if (typeof tool?.name === "string") known.set(tool.name, tool);
        }
      } catch {
        // No file yet, or an unreadable one: an empty catalog, refilled by the next run.
      }
    }
    this.#tools.set(routeId, known);
    return known;
  }
}

const result = (
  id: JsonRpcRequest["id"],
  value: unknown,
  headers?: HeadersInit,
) =>
  Response.json({ jsonrpc: "2.0", id: id ?? null, result: value }, { headers });
const failure = (
  id: JsonRpcRequest["id"],
  code: number,
  message: string,
  status = 200,
) =>
  Response.json(
    { jsonrpc: "2.0", id: id ?? null, error: { code, message } },
    { status },
  );

function asMcpTool(tool: ToolDefinition) {
  const schema =
    typeof tool.parameters === "object" && tool.parameters !== null
      ? tool.parameters
      : { type: "object", properties: {} };
  return {
    name: tool.name,
    description: tool.description ?? "",
    inputSchema: schema,
  };
}

/** The GET stream: holds open, and carries `tools/list_changed` when the catalog grows. */
function notificationStream(
  request: Request,
  route: Route,
  catalog: ToolCatalog,
): Response {
  const encoder = new TextEncoder();
  let stop = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          stop();
        }
      };
      const unsubscribe = catalog.subscribe(route.id, () =>
        write(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n\n`,
        ),
      );
      // Under Bun's idle timeout, and under any proxy's.
      const keepalive = setInterval(() => write(": keepalive\n\n"), 8_000);
      stop = () => {
        clearInterval(keepalive);
        unsubscribe();
      };
      request.signal.addEventListener("abort", () => {
        stop();
        try {
          controller.close();
        } catch {}
      });
    },
    cancel: () => stop(),
  });
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    },
  });
}

export async function handleMcp(
  request: Request,
  route: Route,
  slots: RunSlots,
  catalog: ToolCatalog,
  callTool: ToolCaller,
): Promise<Response> {
  if (request.method === "GET")
    return notificationStream(request, route, catalog);
  if (request.method === "DELETE") return new Response(null, { status: 204 });
  if (request.method !== "POST")
    return new Response(null, { status: 405, headers: { allow: "GET, POST" } });

  let message: JsonRpcRequest;
  try {
    message = (await request.json()) as JsonRpcRequest;
  } catch {
    return failure(null, -32700, "Parse error", 400);
  }
  if (Array.isArray(message) || typeof message?.method !== "string") {
    return failure(
      null,
      -32600,
      "Invalid request: one JSON-RPC message per POST",
      400,
    );
  }
  // A notification gets no JSON-RPC answer.
  if (message.id === undefined) return new Response(null, { status: 202 });

  const run = slots.active(route.id);
  switch (message.method) {
    case "initialize": {
      const asked = message.params?.protocolVersion;
      return result(
        message.id,
        {
          protocolVersion:
            typeof asked === "string" && PROTOCOL_VERSIONS.includes(asked)
              ? asked
              : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "myduet-governed-tools", version: "1.0.0" },
          instructions:
            "These are the tools this myduet deployment grants you. Every call is checked against the " +
            "person's grants and recorded in the deployment's audit trail.",
        },
        // A session id is what makes an MCP client open the GET stream; nothing is kept under it.
        { "mcp-session-id": crypto.randomUUID() },
      );
    }
    case "ping":
      return result(message.id, {});
    case "tools/list":
      return result(message.id, {
        tools: catalog.list(route.id).map(asMcpTool),
      });
    case "tools/call": {
      const name = message.params?.name;
      const args = message.params?.arguments;
      if (typeof name !== "string")
        return failure(message.id, -32602, "tools/call needs a name");
      const text = !run
        ? "Refused. No conversation with this coworker is running, so there is nobody to act for."
        : !run.tools.some((tool) => tool.name === name)
          ? `Refused. ${name} is not a tool this conversation may use.`
          : await callTool(
              route,
              run.assertion,
              name,
              typeof args === "object" && args !== null
                ? (args as Record<string, unknown>)
                : {},
            );
      if (run) {
        run.mcpResults ??= [];
        run.mcpResults.push({ text, isError: isFailure(text) });
      }
      return result(message.id, {
        content: [{ type: "text", text }],
        isError: isFailure(text),
      });
    }
    default:
      return failure(message.id, -32601, `Method not found: ${message.method}`);
  }
}
