import { expect, test } from "bun:test";
import { createReadiness } from "../src/readiness";

test("readiness follows the database down and back up without latching", async () => {
  let clock = 0;
  let up = true;
  let probes = 0;
  const ready = createReadiness(
    async () => {
      probes += 1;
      if (!up) throw new Error("connection refused");
    },
    { cacheMs: 1_000, now: () => clock },
  );

  expect(await ready()).toBe(true);
  up = false;
  // Still inside the cache window: one probe answers a burst.
  expect(await ready()).toBe(true);
  expect(probes).toBe(1);

  clock += 1_000;
  expect(await ready()).toBe(false);

  up = true;
  clock += 1_000;
  expect(await ready()).toBe(true);
  expect(probes).toBe(3);
});

test("a probe that hangs is not ready", async () => {
  const ready = createReadiness(() => new Promise(() => {}), {
    timeoutMs: 20,
  });
  expect(await ready()).toBe(false);
});

test("while a timed-out probe is still waiting on the database, no new probe piles up behind it", async () => {
  let started = 0;
  let unstick!: () => void;
  const ready = createReadiness(
    () => {
      started += 1;
      return new Promise<void>((resolve) => {
        unstick = resolve;
      });
    },
    { timeoutMs: 10, cacheMs: 0 },
  );
  expect(await ready()).toBe(false);
  expect(await ready()).toBe(false);
  expect(started).toBe(1);
  unstick();
  await Bun.sleep(0);
  // Settled: the next answer asks the database again.
  const next = ready();
  unstick();
  expect(await next).toBe(true);
  expect(started).toBe(2);
});
