/**
 * A myduet coworker whose brain is a Hermes Agent profile.
 *
 * `POST /c/<route>` takes an AG-UI run and streams AG-UI back; `/mcp/<route>` is the MCP server that
 * profile uses for every side effect (see mcp.ts). Hermes runs its own loop and its own tools, so the
 * person sees each tool as a completed step; the tools that act on anything are myduet's governed
 * tools, called back through `/api/agent-tools/call`, so grants, policy and audit still apply.
 */
import { answerApproval, createRun, runEvents, stopRun } from "./hermes";
import {
  governedToolCaller,
  handleMcp,
  type ToolCaller,
  ToolCatalog,
} from "./mcp";
import { type Route, sameSecret } from "./routes";
import { type ActiveRun, RunSlots, type ToolDefinition } from "./runs";
import {
  type AgUiEvent,
  createRunTranslator,
  type IncomingMessage,
  planTurn,
} from "./translate";

export type BridgeOptions = {
  routes: Route[];
  /** myduet's governed tool callback, `…/api/agent-tools/call`. */
  toolUrl: string;
  /** The name each Hermes profile gives this bridge under `mcp_servers:`. */
  mcpServer?: string;
  dataDir?: string;
  /** How long a second conversation with the same coworker waits for the first. */
  queueWaitMs?: number;
  heartbeatMs?: number;
  /** How long to wait for a stopped Hermes turn to say it has ended before freeing its profile. */
  settleMs?: number;
  fetcher?: typeof fetch;
  callTool?: ToolCaller;
};

type RunInput = {
  threadId: string;
  runId: string;
  messages: IncomingMessage[];
  tools?: { name?: unknown; description?: unknown; parameters?: unknown }[];
  forwardedProps?: Record<string, unknown>;
};

/** The events after which a Hermes turn will not call another tool. */
const TERMINAL = new Set([
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.interrupted",
]);

const json = (body: unknown, status = 200) => Response.json(body, { status });

function bearer(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

/** The run's governed tools: those myduet says it runs, out of everything in `tools`. */
function deploymentTools(input: RunInput): ToolDefinition[] {
  const names = input.forwardedProps?.openbotDeploymentTools;
  const ours = new Set(
    Array.isArray(names)
      ? names.filter((name) => typeof name === "string")
      : [],
  );
  return (input.tools ?? [])
    .filter(
      (tool): tool is { name: string } & typeof tool =>
        typeof tool.name === "string" && ours.has(tool.name),
    )
    .map((tool) => ({
      name: tool.name,
      ...(typeof tool.description === "string"
        ? { description: tool.description }
        : {}),
      ...(tool.parameters !== undefined ? { parameters: tool.parameters } : {}),
    }));
}

export function createBridge(options: BridgeOptions) {
  const mcpServer = options.mcpServer ?? "openbot";
  const fetcher = options.fetcher ?? fetch;
  const callTool = options.callTool ?? governedToolCaller(options.toolUrl);
  const slots = new RunSlots();
  const catalog = new ToolCatalog(options.dataDir);
  const routes = new Map(options.routes.map((route) => [route.id, route]));
  const encoder = new TextEncoder();

  /** Hermes runs in progress, so a shutdown can stop them rather than orphan them. */
  const live = new Map<string, Route>();

  /**
   * Stop a Hermes turn and wait, bounded, until Hermes says it has ended.
   *
   * Closing the stream does not stop a turn in Hermes, and a turn that is still going can still call
   * tools, so its profile is not handed to the next conversation until it has stopped: otherwise
   * its calls would be refused, or carry the next conversation's assertion.
   */
  async function settle(route: Route, hermesRunId: string): Promise<void> {
    await stopRun(route, hermesRunId, fetcher);
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(),
      options.settleMs ?? 30_000,
    );
    try {
      for await (const event of runEvents(
        route,
        hermesRunId,
        deadline.signal,
        fetcher,
      )) {
        if (TERMINAL.has(String(event.event))) break;
      }
    } catch {
      // Unreachable or gone: nothing more to wait for.
    } finally {
      clearTimeout(timer);
    }
  }

  function runStream(
    route: Route,
    input: RunInput,
    request: Request,
  ): Response {
    const tools = deploymentTools(input);
    try {
      catalog.remember(route.id, tools);
    } catch (error) {
      // The catalog only helps Hermes see tools between runs; failing to save it is not worth a run.
      console.warn(
        `agent-hermes: tool catalog not saved: ${error instanceof Error ? error.message : error}`,
      );
    }
    const turn = planTurn(input.messages);
    const assertion = input.forwardedProps?.openbotRun;

    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        let open = true;
        const write = (text: string) => {
          if (!open) return;
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            open = false;
          }
        };
        const send = (event: AgUiEvent) =>
          write(`data: ${JSON.stringify(event)}\n\n`);
        // A comment line: invisible to an SSE reader, and enough to keep idle timeouts away while
        // Hermes is thinking or waiting on a tool.
        const heartbeat = setInterval(
          () => write(": keepalive\n\n"),
          options.heartbeatMs ?? 5_000,
        );
        const finish = (error?: string) => {
          if (!open) return;
          send(
            error
              ? { type: "RUN_ERROR", message: error }
              : {
                  type: "RUN_FINISHED",
                  threadId: input.threadId,
                  runId: input.runId,
                },
          );
          clearInterval(heartbeat);
          open = false;
          try {
            controller.close();
          } catch {}
        };

        send({
          type: "RUN_STARTED",
          threadId: input.threadId,
          runId: input.runId,
        });
        if (turn.input === null) return finish();

        // Listening before anything waits, so a person who leaves while queued is noticed.
        const stopper = new AbortController();
        const onAbort = () => stopper.abort();
        request.signal.addEventListener("abort", onAbort);
        if (request.signal.aborted) stopper.abort();

        const run: ActiveRun = {
          runId: input.runId,
          threadId: input.threadId,
          assertion: typeof assertion === "string" ? assertion : "",
          tools,
        };
        let release: (() => void) | undefined;
        let hermesRunId: string | undefined;
        let ended = false;
        try {
          release = await slots.acquire(
            route.id,
            run,
            options.queueWaitMs ?? 60_000,
          );
          if (stopper.signal.aborted) return finish();

          const created = await createRun(
            route,
            {
              input: turn.input,
              sessionId: input.threadId,
              instructions: turn.instructions,
            },
            fetcher,
          );
          if ("error" in created) return finish(created.error);
          hermesRunId = created.runId;
          live.set(hermesRunId, route);
          if (stopper.signal.aborted) return finish();

          const translator = createRunTranslator({
            runId: input.runId,
            mcpServer,
            emit: send,
            // Hermes reports no result for a tool; for ours, the bridge saw it at its MCP endpoint.
            // Hermes calls one MCP server one call at a time, so they complete in the order they ran.
            resultFor: () => run.mcpResults?.shift(),
            onApproval: (approval) => {
              /*
               * Everything that acts goes through myduet's governed tools, which carry their own
               * approval, so a Hermes prompt here is for something the profile should not be doing
               * (a native tool left enabled, a spend limit). Declined, and shown as a step so it is
               * not silent. Only ever "deny": with no such choice the prompt is left to Hermes'
               * timeout, which declines it, rather than picking a choice that might approve.
               */
              const callId = `approval_${approval.promptId}`;
              send({
                type: "TOOL_CALL_START",
                toolCallId: callId,
                toolCallName: "hermes_approval",
              });
              send({
                type: "TOOL_CALL_ARGS",
                toolCallId: callId,
                delta: JSON.stringify({ request: approval.command }),
              });
              send({ type: "TOOL_CALL_END", toolCallId: callId });
              void (async () => {
                const answered =
                  approval.choices.includes("deny") &&
                  (await answerApproval(
                    route,
                    created.runId,
                    {
                      promptId: approval.promptId,
                      executionGeneration: approval.executionGeneration,
                      choice: "deny",
                    },
                    fetcher,
                  ));
                send({
                  type: "TOOL_CALL_RESULT",
                  messageId: crypto.randomUUID(),
                  toolCallId: callId,
                  role: "tool",
                  content: answered
                    ? "Declined. Hermes asked to act outside myduet's governed tools; this deployment only allows actions through them."
                    : "Hermes asked for an approval the bridge did not answer; Hermes declines it when it times out.",
                });
              })();
            },
          });

          let outcome: ReturnType<typeof translator.onEvent> = {
            kind: "pending",
          };
          for await (const event of runEvents(
            route,
            created.runId,
            stopper.signal,
            fetcher,
          )) {
            if (TERMINAL.has(String(event.event))) ended = true;
            outcome = translator.onEvent(event);
            if (outcome.kind !== "pending") break;
          }
          translator.finish();
          if (stopper.signal.aborted) return finish();
          if (outcome.kind === "error") return finish(outcome.message);
          if (outcome.kind === "pending")
            return finish("Hermes ended the run without saying how it went.");
          return finish();
        } catch (error) {
          return finish(
            error instanceof Error ? error.message : "Hermes could not answer.",
          );
        } finally {
          request.signal.removeEventListener("abort", onAbort);
          if (hermesRunId) {
            if (!ended) await settle(route, hermesRunId);
            live.delete(hermesRunId);
          }
          release?.();
        }
      },
    });
    return new Response(body, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  }

  async function fetchHandler(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health")
      return json({
        status: "ok",
        framework: "hermes-agent",
        routes: routes.size,
      });

    const match = /^\/(c|mcp)\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname);
    const route = match?.[2] ? routes.get(match[2]) : undefined;
    if (!match || !route) return json({ error: "Not found." }, 404);

    if (match[1] === "mcp") {
      if (!sameSecret(bearer(request), route.mcpToken))
        return json({ error: "Unauthorised." }, 401);
      return handleMcp(request, route, slots, catalog, callTool);
    }

    if (request.method !== "POST")
      return json({ error: "POST an AG-UI run." }, 405);
    if (!sameSecret(bearer(request), route.inboundToken)) {
      return json(
        { error: "This coworker requires its authorization header." },
        401,
      );
    }
    let input: RunInput;
    try {
      input = (await request.json()) as RunInput;
      if (
        typeof input.threadId !== "string" ||
        typeof input.runId !== "string" ||
        !Array.isArray(input.messages) ||
        input.messages.some(
          (message) => typeof message !== "object" || message === null,
        ) ||
        (input.tools !== undefined && !Array.isArray(input.tools))
      ) {
        throw new Error();
      }
    } catch {
      return json({ error: "The request body is not an AG-UI run." }, 400);
    }
    return runStream(route, input, request);
  }

  /** On shutdown: stop every Hermes turn still running, so none is left acting unwatched. */
  async function stopAll(): Promise<void> {
    await Promise.all(
      [...live].map(([runId, route]) => stopRun(route, runId, fetcher)),
    );
  }

  return Object.assign(fetchHandler, { stopAll });
}
