import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { handleMcp, type ToolCaller, ToolCatalog } from "../src/mcp";
import type { Route } from "../src/routes";
import { RunSlots } from "../src/runs";

const route: Route = {
  id: "an",
  inboundToken: "in",
  hermesUrl: "http://hermes:8642",
  profile: "an",
  hermesKey: "hk",
  toolToken: "tt",
  mcpToken: "mt",
};
const searchDocs = {
  name: "search_docs",
  description: "Search",
  parameters: { type: "object", properties: { q: { type: "string" } } },
};

const calls: { assertion: string; name: string; args: unknown }[] = [];
const caller: ToolCaller = async (_route, assertion, name, args) => {
  calls.push({ assertion, name, args });
  return `ran ${name}`;
};
const dataDir = mkdtempSync(join(tmpdir(), "agent-hermes-"));
const slots = new RunSlots();
const catalog = new ToolCatalog(dataDir);
const server = Bun.serve({
  port: 0,
  fetch: (request) => handleMcp(request, route, slots, catalog, caller),
});
afterAll(() => server.stop(true));

test("the official MCP client hears the catalog grow, and calls run only inside a run with its assertion", async () => {
  const client = new Client({ name: "hermes-like", version: "0" });
  let changed = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    changed += 1;
  });
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(`http://localhost:${server.port}/`),
    ),
  );
  expect((await client.listTools()).tools).toEqual([]);

  // A run brings a governed tool: the profile is told over the GET stream, and the list now has it.
  catalog.remember("an", [searchDocs]);
  for (let waited = 0; changed === 0 && waited < 2_000; waited += 20)
    await Bun.sleep(20);
  expect(changed).toBe(1);
  expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
    "search_docs",
  ]);
  // Nothing new, nothing said.
  catalog.remember("an", [searchDocs]);

  // Listed, but outside a run there is nobody to act for.
  expect(
    (await client.callTool({ name: "search_docs", arguments: {} })).isError,
  ).toBe(true);
  expect(calls.length).toBe(0);

  const release = await slots.acquire(
    "an",
    {
      runId: "r1",
      threadId: "t1",
      assertion: "signed-r1",
      tools: [searchDocs],
    },
    1_000,
  );
  const answer = await client.callTool({
    name: "search_docs",
    arguments: { q: "hợp đồng" },
  });
  expect(answer.content).toEqual([{ type: "text", text: "ran search_docs" }]);
  expect(answer.isError).toBe(false);
  expect(calls).toEqual([
    { assertion: "signed-r1", name: "search_docs", args: { q: "hợp đồng" } },
  ]);
  expect(slots.active("an")?.mcpResults).toEqual([
    { text: "ran search_docs", isError: false },
  ]);

  // A tool this run was not given is refused even if an earlier run listed it.
  expect(
    (await client.callTool({ name: "delete_everything", arguments: {} }))
      .isError,
  ).toBe(true);
  expect(calls.length).toBe(1);
  release();
  await client.close();
  expect(changed).toBe(1);

  // The catalog survives a restart of the bridge.
  expect(new ToolCatalog(dataDir).list("an").map((tool) => tool.name)).toEqual([
    "search_docs",
  ]);
});
