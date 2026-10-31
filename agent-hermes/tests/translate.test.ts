import { expect, test } from "bun:test";
import { createSseParser, planTurn } from "../src/translate";

test("frames survive a CRLF split across chunks", () => {
  const parser = createSseParser();
  const first = 'id: 0\r\ndata: {"event": "message.delta", "delta": "a"}\r';
  const second =
    '\n\r\nid: 1\r\ndata: {"event": "run.completed"}\r\n\r\n: stream closed\r\n\r\n';
  const events = [...parser.push(first), ...parser.push(second)];
  expect(events.map((e) => e.data.event)).toEqual([
    "message.delta",
    "run.completed",
  ]);
  expect(events.map((e) => e.seq)).toEqual([0, 1]);
  expect(parser.closed()).toBe(true);
});

test("a turn sends only the trailing user messages, with standing instructions apart", () => {
  expect(
    planTurn([
      { id: "s", role: "system", content: "Role" },
      { id: "u1", role: "user", content: "earlier" },
      { id: "a1", role: "assistant", content: "answer" },
      {
        id: "u2",
        role: "user",
        content: [{ type: "text", text: "now" }, { type: "image" }],
      },
    ]),
  ).toEqual({ input: "now\n[image attachment omitted]", instructions: "Role" });
  expect(
    planTurn([{ id: "a", role: "assistant", content: "x" }]).input,
  ).toBeNull();
});
