/**
 * The four calls the bridge makes to a Hermes profile over `/v1/runs`.
 *
 * `/v1/runs` rather than the OpenAI endpoints: it has a durable run id to stop and to answer
 * approvals against, and a stream that can be resumed. In Hermes' canonical mode a dropped connection
 * does not stop a turn, so stopping is always an explicit call.
 */
import type { Route } from "./routes";
import { createSseParser } from "./translate";

const base = (route: Route) => `${route.hermesUrl}/p/${route.profile}/v1/runs`;
const auth = (route: Route) => ({ authorization: `Bearer ${route.hermesKey}` });

/** Hermes' error text, without echoing anything we sent. */
async function failureOf(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: unknown; code?: unknown };
  } | null;
  const code =
    typeof body?.error?.code === "string" ? body.error.code : undefined;
  if (response.status === 401)
    return "Hermes refused this coworker's key for its profile.";
  if (response.status === 404)
    return "Hermes does not serve this coworker's profile.";
  if (response.status === 429)
    return "Hermes is busy right now. Try again in a moment.";
  return `Hermes answered HTTP ${response.status}${code ? ` (${code})` : ""}.`;
}

export async function createRun(
  route: Route,
  turn: { input: string; sessionId: string; instructions: string },
  fetcher: typeof fetch = fetch,
): Promise<{ runId: string } | { error: string }> {
  try {
    const response = await fetcher(base(route), {
      method: "POST",
      headers: { "content-type": "application/json", ...auth(route) },
      body: JSON.stringify({
        input: turn.input,
        session_id: turn.sessionId,
        ...(turn.instructions ? { instructions: turn.instructions } : {}),
      }),
    });
    if (!response.ok) return { error: await failureOf(response) };
    const body = (await response.json()) as { run_id?: unknown };
    return typeof body.run_id === "string"
      ? { runId: body.run_id }
      : { error: "Hermes started a run without saying which." };
  } catch (error) {
    return {
      error: `Hermes could not be reached: ${error instanceof Error ? error.message : "unknown error"}`,
    };
  }
}

/**
 * Every event of a run, in order, resuming with `Last-Event-ID` when the stream drops before
 * Hermes says it is closed. Ends after `: stream closed`, or when `signal` aborts.
 */
export async function* runEvents(
  route: Route,
  runId: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): AsyncGenerator<Record<string, unknown>> {
  let lastSeq: number | undefined;
  let attempts = 0;
  while (!signal.aborted) {
    const parser = createSseParser();
    try {
      const response = await fetcher(
        `${base(route)}/${encodeURIComponent(runId)}/events`,
        {
          headers: {
            accept: "text/event-stream",
            ...auth(route),
            ...(lastSeq === undefined
              ? {}
              : { "last-event-id": String(lastSeq) }),
          },
          signal,
        },
      );
      if (!response.ok || !response.body)
        throw new Error(await failureOf(response));
      const decoder = new TextDecoder();
      for await (const chunk of response.body) {
        for (const event of parser.push(
          decoder.decode(chunk, { stream: true }),
        )) {
          attempts = 0;
          if (event.seq !== undefined) lastSeq = event.seq;
          yield event.data;
        }
        if (parser.closed()) return;
      }
      if (parser.closed()) return;
    } catch (error) {
      if (signal.aborted) return;
      if (attempts >= 3) throw error;
    }
    if (++attempts > 3)
      throw new Error("Hermes kept dropping the run's event stream.");
    await Bun.sleep(500 * attempts);
  }
}

export async function stopRun(
  route: Route,
  runId: string,
  fetcher: typeof fetch = fetch,
) {
  await fetcher(`${base(route)}/${encodeURIComponent(runId)}/stop`, {
    method: "POST",
    headers: auth(route),
  }).catch(() => {});
}

/** Canonical Hermes takes exactly these three keys; anything else is a 400. */
export async function answerApproval(
  route: Route,
  runId: string,
  answer: { promptId: string; executionGeneration: number; choice: string },
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  const response = await fetcher(
    `${base(route)}/${encodeURIComponent(runId)}/approval`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...auth(route) },
      body: JSON.stringify({
        request_id: answer.promptId,
        execution_generation: answer.executionGeneration,
        choice: answer.choice,
      }),
    },
  ).catch(() => null);
  return response?.ok === true;
}
