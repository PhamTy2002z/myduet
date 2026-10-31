import { afterEach, expect, test } from "bun:test";
import { channelQueryOptions } from "@/lib/channels/queries";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function answer(status: number, body: unknown) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

function load(id: string) {
  const options = channelQueryOptions(id);
  return (options.queryFn as () => Promise<unknown>)();
}

test("a deleted channel is gone, not a failure to retry", async () => {
  answer(404, { error: "Channel channel_x was not found." });
  expect(await load("channel_x")).toBeNull();
});

test("a channel that loads is returned", async () => {
  answer(200, { channel: { id: "channel_y" } });
  expect(await load("channel_y")).toEqual({ id: "channel_y" });
});

test("any other failure still throws the server's sentence", async () => {
  answer(500, { error: "Database is down." });
  await expect(load("channel_z")).rejects.toThrow("Database is down.");
});
