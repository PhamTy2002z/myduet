/**
 * The run each Hermes profile is currently doing, so its MCP calls can be attributed.
 *
 * Hermes calls this bridge's MCP endpoint with headers fixed in the profile's config, so a tool call
 * says which profile it is from and nothing about which conversation. myduet's signed run assertion
 * changes every run. The bridge holds that assertion for the profile's one live run and attaches it to
 * every call; a call with no live run is refused, because there is nobody to act for.
 *
 * ponytail: one live run per profile (per person, with one profile each). A second conversation
 * waits for the first. Lift it if Hermes starts forwarding a per-session header to MCP servers.
 */
export type ActiveRun = {
  runId: string;
  threadId: string;
  /** myduet's signed statement of which Bot and person this run is for. Opaque here. */
  assertion: string;
  /** Tool definitions this run may call through myduet, already filtered to deployment tools. */
  tools: ToolDefinition[];
  /**
   * What each governed call answered, oldest first. Hermes' own `tool.completed` carries no result,
   * so the transcript takes it from here; Hermes makes one call at a time to one MCP server, so the
   * order matches. One queue, not one per name: Hermes clamps and hashes long tool names.
   */
  mcpResults?: { text: string; isError: boolean }[];
};

export type ToolDefinition = {
  name: string;
  description?: string;
  parameters?: unknown;
};

export class RunSlots {
  #active = new Map<string, ActiveRun>();
  #tail = new Map<string, Promise<void>>();

  /**
   * Waits for the profile to be free, then holds it for `run` until the returned release is called.
   * Rejects after `waitMs` rather than queueing forever behind a stuck run.
   */
  async acquire(
    routeId: string,
    run: ActiveRun,
    waitMs: number,
  ): Promise<() => void> {
    const previous = this.#tail.get(routeId) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mine = previous.then(() => held);
    this.#tail.set(routeId, mine);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), waitMs);
    });
    const outcome = await Promise.race([
      previous.then(() => "free" as const),
      timedOut,
    ]);
    clearTimeout(timer);
    if (outcome === "timeout") {
      // Give the place back, but leave the tail alone: `mine` still resolves only once the run ahead
      // finishes, so a later run keeps waiting for that run instead of overlapping it.
      release();
      throw new Error(
        "Another conversation with this coworker is still running.",
      );
    }

    this.#active.set(routeId, run);
    return () => {
      if (this.#active.get(routeId) === run) this.#active.delete(routeId);
      release();
      if (this.#tail.get(routeId) === mine) this.#tail.delete(routeId);
    };
  }

  active(routeId: string): ActiveRun | undefined {
    return this.#active.get(routeId);
  }
}
