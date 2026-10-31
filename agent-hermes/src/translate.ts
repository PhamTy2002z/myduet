/**
 * Pure translation between AG-UI (what myduet speaks) and Hermes' `/v1/runs` (what Hermes speaks).
 *
 * Shapes follow plans/reports/research-261031-0145-hermes-wire-spec.md, read from Hermes source at
 * 7020ea3e. Hermes moves quickly, so every event is narrowed field by field and anything unknown is
 * skipped rather than trusted. No imports: the whole file is testable on its own.
 */

/** One AG-UI event, exactly as it goes onto the SSE stream. */
export type AgUiEvent = { type: string } & Record<string, unknown>;

export type IncomingMessage = { id: string; role: string; content?: unknown };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The readable text of an AG-UI message; attachments are named rather than silently dropped. */
export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      !isRecord(part)
        ? ""
        : part.type === "text" && typeof part.text === "string"
          ? part.text
          : typeof part.type === "string"
            ? `[${part.type} attachment omitted]`
            : "",
    )
    .filter(Boolean)
    .join("\n");
}

/**
 * What one run says to Hermes.
 *
 * Hermes keeps the transcript per `session_id` (the AG-UI thread), so only this turn's input goes:
 * the trailing run of user messages. Standing instructions (system/developer messages, which myduet
 * prepends on every run) travel as `instructions`, layered on Hermes' system prompt for this turn and
 * not stored, so sending them each time does not pile them up in the transcript.
 */
export function planTurn(messages: IncomingMessage[]): {
  input: string | null;
  instructions: string;
} {
  const instructions = messages
    .filter(
      (message) => message.role === "system" || message.role === "developer",
    )
    .map((message) => messageText(message.content).trim())
    .filter(Boolean)
    .join("\n\n");
  const input: string[] = [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message) continue;
    if (message.role === "system" || message.role === "developer") continue;
    if (message.role !== "user") break;
    const text = messageText(message.content).trim();
    if (text) input.unshift(text);
  }
  return { input: input.length > 0 ? input.join("\n\n") : null, instructions };
}

/**
 * Hermes' SSE framing: `id: <seq>` and `data: <json>` lines, frames split by a blank line, `:`
 * comments (`: open`, `: keepalive`, `: stream closed`). The event name is the JSON `event` field.
 * Feed it chunks; it returns whole events and keeps the remainder.
 */
export function createSseParser(): {
  push(chunk: string): { seq?: number; data: Record<string, unknown> }[];
  closed(): boolean;
} {
  let buffer = "";
  let closed = false;
  return {
    push(chunk) {
      // Line endings normalised over the buffer, not the chunk: a CRLF can arrive split in two, so a
      // trailing CR waits for the next chunk before it is read as a line end.
      let raw = buffer + chunk;
      const held = raw.endsWith("\r") ? "\r" : "";
      if (held) raw = raw.slice(0, -1);
      buffer = raw.replace(/\r\n?/g, "\n");
      const out: { seq?: number; data: Record<string, unknown> }[] = [];
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
        let seq: number | undefined;
        const data: string[] = [];
        for (const line of frame.split("\n")) {
          if (line.startsWith(":")) {
            if (line.slice(1).trim() === "stream closed") closed = true;
          } else if (line.startsWith("id:")) {
            const value = Number(line.slice(3).trim());
            if (Number.isFinite(value)) seq = value;
          } else if (line.startsWith("data:")) {
            data.push(line.slice(5).replace(/^ /, ""));
          }
        }
        if (data.length === 0) continue;
        try {
          const parsed: unknown = JSON.parse(data.join("\n"));
          if (isRecord(parsed))
            out.push({ ...(seq === undefined ? {} : { seq }), data: parsed });
        } catch {
          // A frame that is not JSON is not one of Hermes' events; skipped, not guessed at.
        }
      }
      buffer += held;
      return out;
    },
    closed: () => closed,
  };
}

/** Hermes names MCP tools `mcp__<server>__<tool>`; the person should see the tool, not the plumbing. */
export function displayToolName(name: string, server: string): string {
  const prefix = `mcp__${server}__`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

const TOOL_RESULT_MAX_CHARS = 16_000;

export type ApprovalRequest = {
  promptId: string;
  executionGeneration: number;
  command: string;
  choices: string[];
};

export type RunOutcome =
  | { kind: "finished" }
  | { kind: "error"; message: string }
  | { kind: "pending" };

/**
 * The state machine for one run: Hermes events in, AG-UI events out.
 *
 * Tool calls Hermes executed are emitted as completed calls with a `TOOL_CALL_RESULT`, which is how
 * AG-UI says "this happened over there", so the surface shows the work and never executes it. Hermes
 * sends no result body in canonical mode, so `resultFor` lets the bridge supply what its own MCP
 * endpoint saw for that call.
 */
export function createRunTranslator(options: {
  runId: string;
  mcpServer: string;
  emit: (event: AgUiEvent) => void;
  /** The result the bridge saw for the next completed call to its own MCP server. */
  resultFor?: () => { text: string; isError: boolean } | undefined;
  onApproval?: (request: ApprovalRequest) => void;
}): { onEvent(data: Record<string, unknown>): RunOutcome; finish(): void } {
  const { runId, mcpServer, emit } = options;
  let sequence = 0;
  let openTextId: string | null = null;
  let lastMessageId: string | null = null;
  const openCalls = new Map<string, string>();

  const closeText = () => {
    if (!openTextId) return;
    emit({ type: "TEXT_MESSAGE_END", messageId: openTextId });
    openTextId = null;
  };
  const openText = () => {
    if (openTextId) return openTextId;
    sequence += 1;
    // A UUID, as every other Bot's messages are. With `msg_<run>_<n>` the history a reopened
    // thread loads and the events it replays were not recognised as the same message, and the
    // answer showed twice after a reload (observed in the app; a UUID id shows it once).
    openTextId = crypto.randomUUID();
    lastMessageId = openTextId;
    emit({
      type: "TEXT_MESSAGE_START",
      messageId: openTextId,
      role: "assistant",
    });
    return openTextId;
  };
  const text = (value: unknown) => (typeof value === "string" ? value : "");

  return {
    onEvent(data) {
      switch (data.event) {
        case "message.delta": {
          const delta = text(data.delta);
          if (delta)
            emit({
              type: "TEXT_MESSAGE_CONTENT",
              messageId: openText(),
              delta,
            });
          return { kind: "pending" };
        }
        case "tool.started": {
          closeText();
          sequence += 1;
          const callId = text(data.tool_call_id) || `call_${runId}_${sequence}`;
          const tool = text(data.tool) || "tool";
          openCalls.set(callId, tool);
          emit({
            type: "TOOL_CALL_START",
            toolCallId: callId,
            toolCallName: displayToolName(tool, mcpServer),
            ...(lastMessageId ? { parentMessageId: lastMessageId } : {}),
          });
          // Hermes sends a preview of the arguments, not the arguments; it is what there is to show.
          emit({
            type: "TOOL_CALL_ARGS",
            toolCallId: callId,
            delta: JSON.stringify({ preview: text(data.preview) }),
          });
          emit({ type: "TOOL_CALL_END", toolCallId: callId });
          return { kind: "pending" };
        }
        case "tool.completed": {
          const callId = text(data.tool_call_id);
          const tool = text(data.tool) || openCalls.get(callId) || "tool";
          if (!callId) return { kind: "pending" };
          openCalls.delete(callId);
          const seen = tool.startsWith(`mcp__${mcpServer}__`)
            ? options.resultFor?.()
            : undefined;
          const failed = data.error === true || seen?.isError === true;
          const body =
            seen?.text ||
            text(data.preview) ||
            (failed ? "The tool reported an error." : "Done.");
          emit({
            type: "TOOL_CALL_RESULT",
            messageId: crypto.randomUUID(),
            toolCallId: callId,
            content:
              body.length <= TOOL_RESULT_MAX_CHARS
                ? body
                : `${body.slice(0, TOOL_RESULT_MAX_CHARS)}\n… (truncated by the bridge)`,
            role: "tool",
          });
          return { kind: "pending" };
        }
        case "approval.request": {
          const promptId = text(data.prompt_id);
          const generation = data.execution_generation;
          if (promptId && typeof generation === "number") {
            options.onApproval?.({
              promptId,
              executionGeneration: generation,
              command: text(data.command),
              choices: Array.isArray(data.choices)
                ? data.choices.filter(
                    (choice): choice is string => typeof choice === "string",
                  )
                : [],
            });
          }
          return { kind: "pending" };
        }
        case "run.completed":
        case "run.cancelled":
          closeText();
          return { kind: "finished" };
        case "run.failed":
        case "run.interrupted":
          closeText();
          return {
            kind: "error",
            message: text(data.error) || "Hermes could not finish this run.",
          };
        case "run.queued":
          closeText();
          return {
            kind: "error",
            message:
              "Hermes is restarting and has kept this message for later. It will answer once it is back.",
          };
        default:
          return { kind: "pending" };
      }
    },
    finish: closeText,
  };
}
