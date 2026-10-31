/**
 * Which Hermes profile a coworker talks to, and with which credentials.
 *
 * One route per myduet coworker. The coworker's endpoint is `/c/<id>` on this bridge and its
 * write-only auth header carries the route's `inboundToken`; everything else stays here, in a file
 * the deployment mounts, never in the database and never in a log. The file is JSON:
 *
 *   [{ "id": "an", "inboundToken": "…", "hermesUrl": "http://hermes-1:8642", "profile": "an",
 *      "hermesKey": "…", "toolToken": "…", "mcpToken": "…" }]
 *
 * - `hermesKey`: that profile's API_SERVER_KEY.
 * - `toolToken`: the coworker's callback token from myduet (Bot settings → callback token), which
 *   `/api/agent-tools/call` checks against the run's signed assertion.
 * - `mcpToken`: what the Hermes profile presents to this bridge's MCP endpoint.
 */
export type Route = {
  id: string;
  inboundToken: string;
  hermesUrl: string;
  profile: string;
  hermesKey: string;
  toolToken: string;
  mcpToken: string;
};

const FIELDS = [
  "id",
  "inboundToken",
  "hermesUrl",
  "profile",
  "hermesKey",
  "toolToken",
  "mcpToken",
] as const;

/** Parsed and checked whole, so a bad file stops the bridge at boot rather than mid-conversation. */
export function parseRoutes(text: string): Route[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("The routes file is not JSON.");
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("The routes file must be a non-empty JSON array.");
  }
  const routes = raw.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`Route ${index} is not an object.`);
    }
    for (const field of FIELDS) {
      const value = (entry as Record<string, unknown>)[field];
      if (typeof value !== "string" || value.trim() === "") {
        // The field name only: never the value, which may be a secret.
        throw new Error(`Route ${index} is missing ${field}.`);
      }
    }
    const route = entry as Route;
    if (
      !/^[A-Za-z0-9_-]+$/.test(route.id) ||
      !/^[A-Za-z0-9_-]+$/.test(route.profile)
    ) {
      throw new Error(
        `Route ${index}: id and profile may only use letters, digits, - and _.`,
      );
    }
    if (!/^https?:\/\//.test(route.hermesUrl)) {
      throw new Error(`Route ${index}: hermesUrl must be http(s).`);
    }
    return { ...route, hermesUrl: route.hermesUrl.replace(/\/+$/, "") };
  });
  const ids = new Set(routes.map((route) => route.id));
  if (ids.size !== routes.length) throw new Error("Two routes share an id.");
  return routes;
}

/** Constant-time comparison, so a token is not guessable from response timing. */
export function sameSecret(offered: string, expected: string): boolean {
  const a = new TextEncoder().encode(offered);
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++)
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return difference === 0;
}
