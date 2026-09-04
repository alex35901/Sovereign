import type { IncomingMessage, ServerResponse } from "node:http";
// Type-only at the top and loaded at the point of use, the same way the
// Postgres driver is: a bare specifier resolved at module load does not
// survive the way the deployment compiles these functions.
import type Anthropic from "@anthropic-ai/sdk";
import { bearer, passphraseOk, passphraseSet } from "./_auth.js";
import { callerKey, clearFailures, lockedFor, noteFailure, readAttempt, waitMessage } from "./_ratelimit.js";
import { DAILY_MESSAGES, claimMessage, noteTokens, spentToday } from "./_budget.js";

/**
 * The one thing Hopper cannot do from the browser: hold the API key.
 *
 * Everything else about him runs client-side, because that is where the
 * decrypted budget is — the document in Postgres is sealed and this function
 * could not read it if it wanted to. So the split is: the browser owns the
 * conversation and runs the tools against its own data, and this adds the key
 * and forwards one turn to Anthropic.
 *
 * It is deliberately incurious. It does not parse the answer, does not keep
 * the question, and stores nothing but a count of how many turns have been
 * taken today. What passes through is whatever the browser chose to send —
 * a few kilobytes of tool results, not the budget.
 */

type ApiRequest = IncomingMessage & { body?: unknown };

/** Read-only work, answered from figures the browser computed. */
const MODEL = "claude-opus-5";

interface Turn {
  system?: Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  tools?: Anthropic.Tool[];
}

export default async function handler(req: ApiRequest, res: ServerResponse): Promise<void> {
  const send = (code: number, body: unknown): void => {
    res.statusCode = code;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  };

  // GET asks only what today has cost. It runs through the same lock below and
  // answers before any of the model plumbing, so the integrations table can
  // read the count without a question being asked or a token being spent.
  const meterOnly = req.method === "GET";
  if (!meterOnly && req.method !== "POST") return send(405, { error: "GET or POST only." });

  if (!passphraseSet()) {
    return send(503, { error: "No SYNC_PASSPHRASE on the server.", hint: "Settings → Sync across devices → Check the database." });
  }
  const key = (process.env.ANTHROPIC_API_KEY ?? "").trim();
  if (!key && !meterOnly) {
    return send(503, {
      error: "Hopper has no API key.",
      hint: "Add ANTHROPIC_API_KEY in Vercel → Settings → Environment Variables, then redeploy.",
    });
  }

  // The same door, the same lock and the same guessing limit as the document,
  // under its own scope so a wrong answer here does not lock anyone out of
  // their own budget. Failing open on a database blip, as /api/db does: the
  // request cannot get anywhere without the passphrase regardless.
  const who = callerKey("hopper", req.headers);
  let limited = true;
  try {
    const wait = lockedFor(await readAttempt(who), Date.now());
    if (wait > 0) {
      res.setHeader("retry-after", String(wait));
      return send(429, { error: waitMessage(wait), retryAfter: wait });
    }
  } catch {
    limited = false;
  }

  if (!passphraseOk(bearer(req.headers.authorization))) {
    if (limited) {
      try {
        const wait = await noteFailure(who);
        if (wait > 0) {
          res.setHeader("retry-after", String(wait));
          return send(429, { error: waitMessage(wait), retryAfter: wait });
        }
      } catch { /* the refusal below still stands */ }
    }
    return send(401, { error: "Wrong passphrase." });
  }
  if (limited) await clearFailures(who).catch(() => { /* bookkeeping */ });

  if (meterOnly) {
    const spend = await spentToday().catch(() => null);
    // `configured` and not the key itself, ever: the whole point of this
    // function is that the key never leaves it.
    return send(200, { configured: key.length > 0, limit: DAILY_MESSAGES, spend });
  }

  const body = (typeof req.body === "string" ? safeParse(req.body) : req.body) as Turn | undefined;
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return send(400, { error: "Nothing to say." });
  }

  const claim = await claimMessage().catch(() => ({ ok: true, spend: null }));
  if (!claim.ok) {
    return send(429, {
      error: `That is ${DAILY_MESSAGES} questions today, which is the daily limit.`,
      hint: "It resets at midnight UTC. The limit is there so a loop cannot quietly run up a bill.",
    });
  }

  // Streamed, and streamed onward: a chat that sits silent for ten seconds
  // reads as broken, and the answer is worth watching arrive.
  res.statusCode = 200;
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("connection", "keep-alive");
  const event = (data: unknown): void => { res.write(`data: ${JSON.stringify(data)}\n\n`); };

  try {
    const { default: SDK } = await import("@anthropic-ai/sdk");
    const client = new SDK({ apiKey: key });
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 8000,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      ...(body.system ? { system: body.system } : {}),
      ...(body.tools ? { tools: body.tools } : {}),
      messages: body.messages,
    });

    stream.on("text", (text) => event({ type: "text", text }));
    const message = await stream.finalMessage();

    await noteTokens(
      message.usage.input_tokens + (message.usage.cache_read_input_tokens ?? 0),
      message.usage.output_tokens,
    ).catch(() => { /* the answer landed; the meter is not worth failing over */ });

    // The whole message, because the browser needs the tool_use blocks and the
    // stop_reason to decide whether the turn is over.
    event({ type: "done", message, spend: await spentToday().catch(() => null) });
  } catch (err) {
    // Never let an upstream error carry the key back to the browser.
    event({ type: "error", error: await describe(err) });
  } finally {
    res.end();
  }
}

/**
 * What went wrong, in words, with nothing sensitive in them.
 *
 * The SDK's errors carry the request that caused them, and the request carries
 * the key in a header. Only the status and a plain sentence come out.
 */
async function describe(err: unknown): Promise<string> {
  const { default: SDK } = await import("@anthropic-ai/sdk");
  if (err instanceof SDK.AuthenticationError) return "The server's API key was refused. Check ANTHROPIC_API_KEY in Vercel.";
  if (err instanceof SDK.RateLimitError) return "Anthropic is rate-limiting this key. Try again in a minute.";
  if (err instanceof SDK.BadRequestError) return "That request was malformed — this is a bug in Sovereign, not something you did.";
  if (err instanceof SDK.APIError) return `The model could not be reached (${err.status}).`;
  return "The model could not be reached.";
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return undefined; }
}
