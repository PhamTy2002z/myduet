import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createBridge } from "../src/bridge";
import type { Route } from "../src/routes";

const route: Route = {
  id: "an",
  inboundToken: "inbound-an",
  hermesUrl: "http://hermes:8642",
  profile: "an",
  hermesKey: "hermes-key-an-0000",
  toolToken: "tool-an",
  mcpToken: "mcp-an",
};

/** The constructed `/v1/runs` stream: one MCP tool, one approval prompt, then the answer. */
const FIXTURE = readFileSync(
  new URL("./fixtures/run-with-mcp-tool-and-approval.sse", import.meta.url),
  "utf8",
)
  .split("\n")
  .filter((line) => !line.startsWith("#"))
  .join("\n")
  .replace(/^\n+/, "");

type Seen = { url: string; method: string; headers: Headers; body?: unknown };

/**
 * A Hermes profile, as the bridge sees it. Before streaming the run it does what Hermes does when the
 * model reaches for `mcp__openbot__message_bot`: calls the bridge's MCP endpoint with the profile's
 * static token.
 */
function fakeHermes(
  bridge: () => (request: Request) => Promise<Response>,
  stream = FIXTURE,
) {
  const seen: Seen[] = [];
  const fetcher = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    seen.push({ url, method: init?.method ?? "GET", headers, body });
    if (url.endsWith("/p/an/v1/runs")) {
      return Response.json(
        { run_id: "run_1", status: "started", replayed: false },
        { status: 202 },
      );
    }
    if (url.endsWith("/v1/runs/run_1/events")) {
      await bridge()(
        new Request("http://bridge/mcp/an", {
          method: "POST",
          headers: {
            authorization: "Bearer mcp-an",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 7,
            method: "tools/call",
            params: {
              name: "message_bot",
              arguments: { bot: "ops", text: "Restart staging" },
            },
          }),
        }),
      );
      return new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      });
    }
    if (url.endsWith("/approval"))
      return Response.json({ run_id: "run_1", status: "resolved" });
    if (url.endsWith("/stop"))
      return Response.json({ run_id: "run_1", status: "stopping" });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { seen, fetcher };
}

const runInput = {
  threadId: "thread-1",
  runId: "agui-run-1",
  messages: [
    { id: "s", role: "system", content: "You are An's coworker." },
    { id: "u1", role: "user", content: "Nhắn ops bot restart staging" },
  ],
  tools: [
    {
      name: "message_bot",
      description: "Message another Bot",
      parameters: { type: "object", properties: {} },
    },
    {
      name: "render_chart",
      description: "Drawn by the browser",
      parameters: {},
    },
  ],
  forwardedProps: {
    openbotRun: "signed-assertion",
    openbotDeploymentTools: ["message_bot"],
  },
};

async function events(response: Response) {
  const text = await response.text();
  return text
    .split("\n\n")
    .filter((frame) => frame.startsWith("data: "))
    .map(
      (frame) =>
        JSON.parse(frame.slice(6)) as { type: string } & Record<
          string,
          unknown
        >,
    );
}

test("a Hermes run becomes an AG-UI run, with the governed call's real result and the approval declined", async () => {
  const governed: unknown[] = [];
  let handler!: (request: Request) => Promise<Response>;
  const hermes = fakeHermes(() => handler);
  handler = createBridge({
    routes: [route],
    toolUrl: "http://myduet/api/agent-tools/call",
    fetcher: hermes.fetcher,
    callTool: async (_route, assertion, name, args) => {
      governed.push({ assertion, name, args });
      return "Sent to ops.";
    },
  });

  const response = await handler(
    new Request("http://bridge/c/an", {
      method: "POST",
      headers: {
        authorization: "Bearer inbound-an",
        "content-type": "application/json",
      },
      body: JSON.stringify(runInput),
    }),
  );
  const out = await events(response);
  const types = out.map((event) => event.type);

  expect(types[0]).toBe("RUN_STARTED");
  // UUID message ids: anything else is shown twice when the thread is reopened.
  for (const event of out.filter((e) => e.type === "TEXT_MESSAGE_START")) {
    expect(String(event.messageId)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  }
  expect(types.at(-1)).toBe("RUN_FINISHED");
  expect(
    out.filter((e) => e.type === "TEXT_MESSAGE_CONTENT").map((e) => e.delta),
  ).toEqual(["I'll send that to the ops bot.", "Done, the ops bot has it."]);

  // The governed call went through myduet with the run's assertion, and only a deployment tool was offered.
  expect(governed).toEqual([
    {
      assertion: "signed-assertion",
      name: "message_bot",
      args: { bot: "ops", text: "Restart staging" },
    },
  ]);
  const start = out.find(
    (e) => e.type === "TOOL_CALL_START" && e.toolCallId === "call_01HZX9",
  );
  expect(start?.toolCallName).toBe("message_bot");
  const toolResult = out.find(
    (e) => e.type === "TOOL_CALL_RESULT" && e.toolCallId === "call_01HZX9",
  );
  expect(toolResult?.content).toBe("Sent to ops.");

  // Hermes' approval prompt was declined with exactly the three keys canonical Hermes accepts.
  const approval = hermes.seen.find((call) => call.url.endsWith("/approval"));
  expect(approval?.body).toEqual({
    request_id: "apr_7c2e",
    execution_generation: 3,
    choice: "deny",
  });

  // The run was created on the profile's prefix, with the profile's key, the thread as the session,
  // only this turn's input, and the standing instructions alongside.
  const created = hermes.seen.find((call) =>
    call.url.endsWith("/p/an/v1/runs"),
  );
  expect(created?.headers.get("authorization")).toBe(
    "Bearer hermes-key-an-0000",
  );
  expect(created?.body).toEqual({
    input: "Nhắn ops bot restart staging",
    session_id: "thread-1",
    instructions: "You are An's coworker.",
  });
});

test("a failed Hermes run is a RUN_ERROR with Hermes' reason", async () => {
  let handler!: (request: Request) => Promise<Response>;
  const failed =
    ': open\n\nid: 0\ndata: {"event": "run.failed", "run_id": "run_1", "completed": false, "error": "model provider unavailable", "seq": 0}\n\n: stream closed\n\n';
  const hermes = fakeHermes(() => handler, failed);
  handler = createBridge({
    routes: [route],
    toolUrl: "http://x",
    fetcher: hermes.fetcher,
    callTool: async () => "",
  });
  const out = await events(
    await handler(
      new Request("http://bridge/c/an", {
        method: "POST",
        headers: { authorization: "Bearer inbound-an" },
        body: JSON.stringify(runInput),
      }),
    ),
  );
  expect(out.at(-1)).toEqual({
    type: "RUN_ERROR",
    message: "model provider unavailable",
  });
});

test("a person who stops the run stops the Hermes turn too", async () => {
  let handler!: (request: Request) => Promise<Response>;
  // A stream that never closes on its own: Hermes still working.
  const hermes = fakeHermes(
    () => handler,
    ': open\n\nid: 0\ndata: {"event": "message.delta", "delta": "Thinking", "seq": 0}\n\n',
  );
  const never = hermes.fetcher;
  const fetcher = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const response = await never(input, init);
    if (!String(input).endsWith("/events")) return response;
    const text = await response.text();
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(text));
          init?.signal?.addEventListener("abort", () =>
            controller.error(new Error("aborted")),
          );
        },
      }),
    );
  }) as typeof fetch;
  handler = createBridge({
    routes: [route],
    toolUrl: "http://x",
    fetcher,
    callTool: async () => "",
  });
  const abort = new AbortController();
  const response = await handler(
    new Request("http://bridge/c/an", {
      method: "POST",
      headers: { authorization: "Bearer inbound-an" },
      body: JSON.stringify(runInput),
      signal: abort.signal,
    }),
  );
  const reader = response.body!.getReader();
  await reader.read();
  await Bun.sleep(30);
  abort.abort();
  await Bun.sleep(30);
  expect(
    hermes.seen.some(
      (call) =>
        call.url.endsWith("/v1/runs/run_1/stop") && call.method === "POST",
    ),
  ).toBe(true);
});

test("the wrong inbound or MCP token is refused, and an unknown coworker is not found", async () => {
  const handler = createBridge({
    routes: [route],
    toolUrl: "http://x",
    callTool: async () => "",
  });
  const post = (path: string, token: string) =>
    handler(
      new Request(`http://bridge${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: "{}",
      }),
    );
  expect((await post("/c/an", "inbound-binh")).status).toBe(401);
  expect((await post("/mcp/an", "inbound-an")).status).toBe(401);
  expect((await post("/c/binh", "inbound-an")).status).toBe(404);
});

test("a person who leaves while Hermes is still creating the run gets that run stopped, and the profile waits for it", async () => {
  const calls: string[] = [];
  let finishCreate!: () => void;
  const created = new Promise<void>((resolve) => {
    finishCreate = resolve;
  });
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url.replace("http://hermes:8642/p/an/v1/runs", ""));
    if (url.endsWith("/p/an/v1/runs")) {
      await created;
      return Response.json({ run_id: "run_slow" }, { status: 202 });
    }
    if (url.endsWith("/stop")) return Response.json({ status: "stopping" });
    if (url.endsWith("/events")) {
      return new Response(
        ': open\n\nid: 0\ndata: {"event": "run.cancelled", "seq": 0}\n\n: stream closed\n\n',
      );
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const handler = createBridge({
    routes: [route],
    toolUrl: "http://x",
    fetcher,
    callTool: async () => "",
    settleMs: 1_000,
  });
  const abort = new AbortController();
  const response = await handler(
    new Request("http://bridge/c/an", {
      method: "POST",
      headers: { authorization: "Bearer inbound-an" },
      body: JSON.stringify(runInput),
      signal: abort.signal,
    }),
  );
  const done = response.text();
  await Bun.sleep(20);
  abort.abort();
  finishCreate();
  await done;
  await Bun.sleep(20);
  expect(calls).toEqual(["", "/run_slow/stop", "/run_slow/events"]);
});

test("a stream that ends without saying how the run went gets the run stopped before the profile is freed", async () => {
  const calls: string[] = [];
  let eventsCalls = 0;
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url.replace("http://hermes:8642/p/an/v1/runs", ""));
    if (url.endsWith("/p/an/v1/runs"))
      return Response.json({ run_id: "run_cut" }, { status: 202 });
    if (url.endsWith("/stop")) return Response.json({ status: "stopping" });
    if (url.endsWith("/events")) {
      eventsCalls += 1;
      // While the run is live: a delta and then a closed stream with no terminal event.
      return new Response(
        eventsCalls <= 4
          ? ': open\n\nid: 0\ndata: {"event": "message.delta", "delta": "Half", "seq": 0}\n\n: stream closed\n\n'
          : ': open\n\nid: 1\ndata: {"event": "run.cancelled", "seq": 1}\n\n: stream closed\n\n',
      );
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const handler = createBridge({
    routes: [route],
    toolUrl: "http://x",
    fetcher,
    callTool: async () => "",
    settleMs: 1_000,
  });
  const out = await events(
    await handler(
      new Request("http://bridge/c/an", {
        method: "POST",
        headers: { authorization: "Bearer inbound-an" },
        body: JSON.stringify(runInput),
      }),
    ),
  );
  expect(out.at(-1)?.type).toBe("RUN_ERROR");
  await Bun.sleep(50);
  expect(calls).toContain("/run_cut/stop");
  expect(calls.indexOf("/run_cut/stop")).toBeGreaterThan(
    calls.indexOf("/run_cut/events"),
  );
});

test("two people on two profiles stay apart: neither's token, run or tools reach the other", async () => {
  const binh: Route = {
    ...route,
    id: "binh",
    profile: "binh",
    inboundToken: "inbound-binh",
    hermesKey: "hermes-key-binh-00",
    toolToken: "tool-binh",
    mcpToken: "mcp-binh",
  };
  const governed: { route: string; assertion: string }[] = [];
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let handler!: ReturnType<typeof createBridge>;
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/p/an/v1/runs"))
      return Response.json({ run_id: "run_an" }, { status: 202 });
    if (url.endsWith("/run_an/events")) {
      // While An's turn is live, Binh's profile tries to use the bridge with its own credentials.
      const mcp = (token: string, path: string) =>
        handler(
          new Request(`http://bridge${path}`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: { name: "message_bot", arguments: {} },
            }),
          }),
        ).then(async (r) => ({
          status: r.status,
          body: r.status === 200 ? await r.json() : null,
        }));
      const binhOwn = await mcp("mcp-binh", "/mcp/binh");
      const binhOnAn = await mcp("mcp-binh", "/mcp/an");
      seen.push({ binhOwn, binhOnAn });
      await hold;
      return new Response(
        ': open\n\nid: 0\ndata: {"event": "run.completed", "seq": 0}\n\n: stream closed\n\n',
      );
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const seen: {
    binhOwn: {
      status: number;
      body: { result?: { isError?: boolean } } | null;
    };
    binhOnAn: {
      status: number;
      body: { result?: { isError?: boolean } } | null;
    };
  }[] = [];
  handler = createBridge({
    routes: [route, binh],
    toolUrl: "http://x",
    fetcher,
    callTool: async (r, assertion) => {
      governed.push({ route: r.id, assertion });
      return "ok";
    },
  });

  // Binh's inbound token does not open An's coworker.
  expect(
    (
      await handler(
        new Request("http://bridge/c/an", {
          method: "POST",
          headers: { authorization: "Bearer inbound-binh" },
          body: JSON.stringify(runInput),
        }),
      )
    ).status,
  ).toBe(401);

  const running = handler(
    new Request("http://bridge/c/an", {
      method: "POST",
      headers: { authorization: "Bearer inbound-an" },
      body: JSON.stringify(runInput),
    }),
  ).then((r) => r.text());
  for (let waited = 0; seen.length === 0 && waited < 2_000; waited += 10)
    await Bun.sleep(10);
  release();
  await running;

  // On its own endpoint Binh has no live run, so nothing runs; on An's, its token is refused.
  expect(seen[0]?.binhOwn.body?.result?.isError).toBe(true);
  expect(seen[0]?.binhOnAn.status).toBe(401);
  // An's signed assertion was never spent by anyone.
  expect(governed).toEqual([]);
});
