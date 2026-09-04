import type Anthropic from "@anthropic-ai/sdk";
import type { DB } from "../../types.js";
import { SCHEMAS, runTool } from "./tools.js";
import { SYSTEM, digest } from "./digest.js";
import { passphrase } from "../cloud.js";

/**
 * The agent loop, running in the browser because that is where the money is.
 *
 * The document in Postgres is sealed and the server cannot read it, so a
 * server-side agent would have to be handed the plaintext to work at all. This
 * way the data never leaves the tab except as the few kilobytes a tool
 * returned, and /api/hopper only ever sees that slice — it adds the API key
 * and forwards one turn.
 *
 * The loop itself is the ordinary one: ask, and while the answer is a request
 * for tools, run them and ask again.
 */

const ENDPOINT = "/api/hopper";
/** A wrong answer would loop for ever otherwise; nothing here needs ten. */
const MAX_TURNS = 6;

/**
 * One question and its answer, as stored.
 *
 * Deliberately not the raw message array. Replaying old tool results would
 * spend tokens re-reading figures that have since moved, and would let a stale
 * total contradict a fresh one in the same conversation — so the thread
 * remembers what was said, and any number it needs again it looks up again.
 */
export interface Exchange {
  id: string;
  question: string;
  answer: string;
  /** Which tools were used, so the answer can show its working. */
  used: string[];
  at: string;
}

/** A stored thread, as the two turns the model should see next time. */
export const replay = (history: Exchange[]): Anthropic.MessageParam[] =>
  history.flatMap((e): Anthropic.MessageParam[] => [
    { role: "user", content: e.question },
    { role: "assistant", content: e.answer },
  ]);

export interface Progress {
  /** Text as it arrives, for the bubble that is still being written. */
  text: string;
  /** Which tools have run this turn, so the user can see the work. */
  used: string[];
  thinking: boolean;
}

export class HopperError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = "HopperError";
  }
}

/** One turn: send what we have, stream the answer back. */
async function turn(
  messages: Anthropic.MessageParam[],
  onText: (chunk: string) => void,
): Promise<Anthropic.Message> {
  const pass = passphrase();
  if (!pass) throw new HopperError("This browser is not connected.", "Settings → Sync across devices.");

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${pass}` },
    body: JSON.stringify({
      // The frozen half first and cached: the instructions and the tool list
      // never change, so they are the prefix worth paying for once.
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      tools: SCHEMAS,
      messages,
    }),
  });

  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => null) as { error?: string; hint?: string } | null;
    throw new HopperError(body?.error ?? `Hopper could not be reached (${res.status}).`, body?.hint);
  }

  // Server-sent events: text deltas as they come, then the whole message.
  const reader = res.body.getReader();
  const decode = new TextDecoder();
  let buffer = "";
  let done: Anthropic.Message | null = null;

  for (;;) {
    const { value, done: finished } = await reader.read();
    if (finished) break;
    buffer += decode.decode(value, { stream: true });
    // A chunk can split an event in half, so only whole ones are taken.
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      const event = JSON.parse(line.slice(6)) as
        | { type: "text"; text: string }
        | { type: "done"; message: Anthropic.Message }
        | { type: "error"; error: string };
      if (event.type === "text") onText(event.text);
      else if (event.type === "done") done = event.message;
      else throw new HopperError(event.error);
    }
  }

  if (!done) throw new HopperError("Hopper stopped mid-sentence. Try again.");
  return done;
}

/**
 * Ask a question and run it to an answer.
 *
 * `history` is every previous exchange's messages, replayed so the thread has
 * memory. `onProgress` is called as things happen — text arriving, a tool
 * running — because a chat that sits silent reads as broken.
 */
export async function ask(
  db: DB,
  history: Exchange[],
  question: string,
  onProgress: (p: Progress) => void,
): Promise<{ answer: string; used: string[] }> {
  // The digest rides with the question rather than in the system prompt: it
  // changes whenever the data does, and in the prefix it would throw away the
  // cache on every edit.
  const opening = `${digest(db)}\n\n---\n\n${question}`;
  const messages: Anthropic.MessageParam[] = [
    ...replay(history),
    { role: "user", content: opening },
  ];

  const used: string[] = [];
  let text = "";

  for (let i = 0; i < MAX_TURNS; i++) {
    onProgress({ text, used: [...used], thinking: true });
    const message = await turn(messages, (chunk) => {
      text += chunk;
      onProgress({ text, used: [...used], thinking: false });
    });

    messages.push({ role: "assistant", content: message.content });

    if (message.stop_reason !== "tool_use") {
      onProgress({ text, used: [...used], thinking: false });
      return { answer: text, used };
    }

    // Every tool call in the turn, answered in one user message — splitting
    // them teaches the model to stop asking for several at once.
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of message.content) {
      if (block.type !== "tool_use") continue;
      used.push(block.name);
      onProgress({ text, used: [...used], thinking: true });
      const out = runTool(db, block.name, block.input);
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(out),
      });
    }
    messages.push({ role: "user", content: results });
  }

  throw new HopperError("Hopper went round in circles and gave up. Try asking more specifically.");
}
