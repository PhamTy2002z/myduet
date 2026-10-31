/**
 * Whether this server can answer, for a load balancer's readiness probe.
 *
 * `/health` says the process is up; this says the database behind it is too. The answer is cached
 * for a few seconds so a probe storm is one query, and it is always asked again after that, so a
 * failure during an outage clears on its own once the database is back instead of latching.
 */
export function createReadiness(
  probe: () => Promise<unknown>,
  options: { cacheMs?: number; timeoutMs?: number; now?: () => number } = {},
): () => Promise<boolean> {
  const cacheMs = options.cacheMs ?? 3_000;
  const timeoutMs = options.timeoutMs ?? 2_000;
  const now = options.now ?? Date.now;
  let last: { at: number; ready: boolean } | undefined;
  let pending: Promise<boolean> | undefined;
  // A probe that timed out may still be waiting on the database; while it is, a new one would only
  // queue behind it on the pool, so the answer stays "not ready" until it settles.
  let stuck: Promise<unknown> | undefined;

  const check = async () => {
    if (stuck) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = probe();
    try {
      await Promise.race([
        attempt,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("timed out")), timeoutMs);
        }),
      ]);
      return true;
    } catch {
      stuck = attempt;
      const clear = () => {
        if (stuck === attempt) stuck = undefined;
      };
      attempt.then(clear, clear);
      return false;
    } finally {
      clearTimeout(timer);
    }
  };

  return async () => {
    if (last && now() - last.at < cacheMs) return last.ready;
    pending ??= check().then((ready) => {
      last = { at: now(), ready };
      pending = undefined;
      return ready;
    });
    return pending;
  };
}
