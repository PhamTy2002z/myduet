import { expect, test } from "bun:test";
import { parseRoutes, sameSecret } from "../src/routes";
import { RunSlots } from "../src/runs";

const run = (runId: string) => ({
  runId,
  threadId: "t",
  assertion: `signed-${runId}`,
  tools: [],
});

test("one live run per profile: the second waits, then takes over", async () => {
  const slots = new RunSlots();
  const releaseFirst = await slots.acquire("an", run("r1"), 1_000);
  let secondStarted = false;
  const second = slots.acquire("an", run("r2"), 1_000).then((release) => {
    secondStarted = true;
    return release;
  });
  await Bun.sleep(20);
  expect(secondStarted).toBe(false);
  expect(slots.active("an")?.runId).toBe("r1");
  // Another person's profile is not held up.
  const releaseOther = await slots.acquire("binh", run("r3"), 1_000);
  releaseOther();

  releaseFirst();
  const releaseSecond = await second;
  expect(slots.active("an")?.runId).toBe("r2");
  releaseSecond();
  expect(slots.active("an")).toBeUndefined();
});

test("a run that waits too long is refused and does not block the queue behind it", async () => {
  const slots = new RunSlots();
  const releaseFirst = await slots.acquire("an", run("r1"), 1_000);
  await expect(slots.acquire("an", run("r2"), 20)).rejects.toThrow(
    "still running",
  );
  // The run that timed out must not open the way: r3 still waits for r1.
  let thirdStarted = false;
  const third = slots.acquire("an", run("r3"), 1_000).then((release) => {
    thirdStarted = true;
    return release;
  });
  await Bun.sleep(30);
  expect(thirdStarted).toBe(false);
  expect(slots.active("an")?.runId).toBe("r1");
  releaseFirst();
  const releaseThird = await third;
  expect(slots.active("an")?.runId).toBe("r3");
  releaseThird();
});

test("a routes file is checked whole and never echoes a secret", () => {
  const good = {
    id: "an",
    inboundToken: "secret-in",
    hermesUrl: "http://hermes:8642/",
    profile: "an",
    hermesKey: "secret-hermes",
    toolToken: "secret-tool",
    mcpToken: "secret-mcp",
  };
  expect(parseRoutes(JSON.stringify([good]))[0]?.hermesUrl).toBe(
    "http://hermes:8642",
  );
  expect(() =>
    parseRoutes(JSON.stringify([{ ...good, toolToken: "" }])),
  ).toThrow("missing toolToken");
  expect(() => parseRoutes(JSON.stringify([good, good]))).toThrow(
    "share an id",
  );
  expect(() =>
    parseRoutes(JSON.stringify([{ ...good, profile: "../x" }])),
  ).toThrow("letters");
  try {
    parseRoutes(JSON.stringify([{ ...good, hermesUrl: "ftp://x" }]));
  } catch (error) {
    expect(String(error)).not.toContain("secret");
  }
  expect(sameSecret("abc", "abc")).toBe(true);
  expect(sameSecret("abc", "abd")).toBe(false);
  expect(sameSecret("abc", "abcd")).toBe(false);
});
