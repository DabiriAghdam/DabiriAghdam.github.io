// Fallback chain for the chat completion call.
//
// Groq stays primary: it is the fastest of the three and the only one whose model is
// pinned, so answers stay consistent. The other two exist so that a Groq outage or an
// exhausted daily token budget degrades into a slower answer instead of an error,
// which is the whole point — a visitor who gets "try again tomorrow" simply leaves.
// Every provider here speaks the OpenAI chat-completions dialect, so the request and
// SSE parsing are shared apart from the per-provider body quirks noted below.

// The browser aborts the whole request at 60s (assets/js/chatbot.js). Trying three
// providers in sequence has to fit inside that with room to spare, so the chain runs
// against one shared deadline rather than a fresh timeout per provider — otherwise
// the last provider in the chain could never answer in time to be worth having.
const TOTAL_BUDGET_MS = 45_000;
// A streaming response returns headers as soon as generation starts, so a slow
// handshake is a dead provider, not a slow answer: fail over quickly. Once the
// headers arrive, the body gets whatever is left of the shared deadline.
const STREAM_HEADER_TIMEOUT_MS = 10_000;
// A non-streaming response withholds headers until the whole answer is generated, so
// the same short timeout would abort healthy providers mid-thought.
const NON_STREAM_TIMEOUT_MS = 20_000;
// Below this there is not enough of the budget left for an answer to arrive, and
// starting an attempt would only delay the error the visitor is going to see anyway.
const MIN_ATTEMPT_MS = 3_000;
// An error body is a few hundred bytes of JSON. Reading it must stay on a leash of
// its own: a provider that returns headers and then stalls the body would otherwise
// hang the chain at the one point where no deadline was armed.
const ERROR_BODY_TIMEOUT_MS = 2_000;
const MAX_ERROR_BODY_CHARS = 500;

const PROVIDERS = [
  {
    name: "groq",
    url: "https://api.groq.com/openai/v1/chat/completions",
    keyVar: "GROQ_API_KEY",
    modelVar: "MODEL",
    defaultModel: "openai/gpt-oss-20b",
    // Groq is the only token-metered tier here (200K/day), so it keeps the tight
    // budget; OpenRouter below is request-metered and can afford room to think.
    maxCompletionTokens: 800,
    // gpt-oss is a reasoning model; "low" is the floor, and include_reasoning keeps
    // the chain-of-thought out of the visible answer so it can be stored separately.
    extraBody: { reasoning_effort: "low", include_reasoning: true },
  },
  {
    name: "openrouter",
    url: "https://openrouter.ai/api/v1/chat/completions",
    keyVar: "OPENROUTER_API_KEY",
    modelVar: "OPENROUTER_MODEL",
    defaultModel: "openrouter/free",
    // "openrouter/free" is a router, not a model: it picks a different free model per
    // request, so the served model is only known from the response. That is why the
    // audit records the model the response reports rather than the one requested.
    //
    // It routes to reasoning models that think at length, and the thinking is spent
    // from the same budget as the answer. At 800 tokens two runs in three came back
    // with finish_reason "length" and an entirely empty answer. Capping the reasoning
    // and widening the budget fixed it: 10 of 10 across three routed models. Note
    // that reasoning cannot simply be switched off here — {"enabled": false} makes
    // roughly half of the routes reject the request with "Reasoning is mandatory for
    // this endpoint."
    maxCompletionTokens: 1600,
    extraBody: { include_reasoning: true, reasoning: { effort: "low" } },
  },
  {
    name: "gemini",
    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    keyVar: "GEMINI_API_KEY",
    modelVar: "GEMINI_MODEL",
    defaultModel: "gemma-4-26b-a4b-it",
    maxCompletionTokens: 800,
    // Google's compatibility layer rejects unknown fields outright, so it gets none of
    // Groq's reasoning flags. Gemma 4 does not accept a thinking *budget* — both
    // reasoning_effort:"low" and thinking_budget:0 are refused — but it does accept a
    // thinking *level*, exposed here as reasoning_effort, where only "minimal" and
    // "high" are valid. "minimal" switches thinking off: the same question costs 14
    // total tokens instead of 247, and answers arrive in under a second.
    extraBody: { reasoning_effort: "minimal" },
  },
];

// Most failures advance to the next provider, including 400/401/403/404. Those look
// permanent but they are permanent *for one provider*: Google's endpoint 400s on
// fields Groq requires, a revoked key is a 401 at one vendor and irrelevant at the
// next, and a retired model id is a 404 only where it was retired.
//
// Content-policy refusals are the exception, and the distinction is about the prompt
// rather than the provider. A moderation rejection is a judgement on what the visitor
// asked, so replaying it down the chain is shopping the same flagged prompt around
// until some provider accepts it — which is both a worse answer to give and a worse
// thing to be doing. Those stop the chain and the visitor is told no.
//
// Auth failures are checked first because a 403 is ambiguous: "permission denied" for
// a bad key must still fall through, and only an explicit moderation signal stops.
//
// Both patterns are matched against the provider's own fields only — code, type,
// status and message — never the whole body. OpenRouter's moderation 403 carries the
// offending text back in metadata.flagged_input, so matching the raw body would let a
// visitor who wrote "api key" have their flagged prompt read as an auth failure and
// forwarded to the next two providers: precisely the replay this check exists to stop.
const CONTENT_REJECTION = /content[_ -]?(?:filter|policy)|policy[_ -]?violation|prohibited[_ -]?content|\bmoderation\b|\bflagged\b|safety (?:setting|filter|policy|reason)|blocked (?:by|due to|for) safety/i;
const AUTH_FAILURE = /api[_ -]?key|unauthori[sz]ed|unauthenticated|permission denied|invalid[_ -]?credential|credential|expired|quota|billing/i;

function classifiableText(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Not JSON (a proxy's plain-text 502, or our own "<unreadable>" marker). There is
    // no visitor text to echo in that case, so the raw body is safe to read.
    return body;
  }
  const error = parsed?.error ?? parsed;
  if (!error || typeof error !== "object") return "";
  return [error.code, error.type, error.status, error.reason, error.message]
    .filter((field) => typeof field === "string" || typeof field === "number")
    .join(" ");
}

export function isContentRejection(status, body) {
  if (status !== 400 && status !== 403) return false;
  const text = classifiableText(body);
  if (AUTH_FAILURE.test(text)) return false;
  return CONTENT_REJECTION.test(text);
}

// A 429 says "slow down"; only the body says for how long. Groq distinguishes its
// per-minute bucket from its per-day one in the message ("on tokens per minute (TPM)"
// versus "tokens per day (TPD)"), Gemini names "limit per day", and OpenRouter returns
// "free-models-per-day". Retry-After is the better signal when it is present, but it
// is not always sent — and a missing header must not be read as "try again shortly",
// which would tell a visitor to wait a moment for a budget that returns tomorrow.
const DAILY_EXHAUSTION = /per[ -]day|\bTPD\b|\bRPD\b|\bdaily\b|per day/i;

export function isDailyExhaustion(retryAfter, body = "") {
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter > 900;
  return DAILY_EXHAUSTION.test(classifiableText(body));
}

export function activeProviders(env) {
  return PROVIDERS
    .filter((provider) => env[provider.keyVar])
    .map((provider) => ({ ...provider, model: env[provider.modelVar] || provider.defaultModel }));
}

// The audit stores "provider:model" so the admin page can say which service answered
// without a second column. Rows written before the fallback chain existed hold a bare
// model id, which the renderer still handles.
export function providerLabel(providerName, model) {
  return `${providerName}:${model}`;
}

export async function callChatProvider(env, { messages, systemPrompt, wantsStream, maxCompletionTokens }) {
  const providers = activeProviders(env);
  if (!providers.length) return { ok: false, status: 502, attempts: [] };

  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const attempts = [];

  for (const provider of providers) {
    const remaining = deadline - Date.now();
    if (remaining < MIN_ATTEMPT_MS) {
      attempts.push({ provider: provider.name, status: 0, reason: "deadline" });
      break;
    }

    const controller = new AbortController();
    // Two phases on one controller: a short leash until the headers arrive, then the
    // rest of the shared deadline for the body. A single AbortSignal.timeout cannot
    // express that, because the signal it produces also governs the body stream.
    const headerBudget = Math.min(wantsStream ? STREAM_HEADER_TIMEOUT_MS : NON_STREAM_TIMEOUT_MS, remaining);
    let timer = setTimeout(() => controller.abort(new Error("provider timed out")), headerBudget);

    let response;
    try {
      response = await fetch(provider.url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env[provider.keyVar]}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: provider.model,
          messages: [{ role: "system", content: systemPrompt }, ...messages],
          max_completion_tokens: provider.maxCompletionTokens || maxCompletionTokens,
          temperature: 0.3,
          stream: wantsStream,
          ...provider.extraBody,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      console.error(`${provider.name} request failed`, error);
      attempts.push({ provider: provider.name, status: 0 });
      continue;
    }
    clearTimeout(timer);

    if (response.ok) {
      timer = setTimeout(() => controller.abort(new Error("provider stalled")), Math.max(0, deadline - Date.now()));
      // The caller owns the body, so it also owns the timer: leaving it armed would
      // hold the isolate open after a fast answer.
      return { ok: true, response, provider, attempts, release: () => clearTimeout(timer) };
    }

    const retryAfter = Number(response.headers.get("Retry-After"));
    // Re-arm before touching the body: between clearTimeout above and here the read
    // would otherwise be the one unguarded await in the chain.
    timer = setTimeout(() => controller.abort(new Error("error body stalled")), Math.min(ERROR_BODY_TIMEOUT_MS, Math.max(0, deadline - Date.now())));
    let detail = "";
    try {
      detail = (await response.text()).slice(0, MAX_ERROR_BODY_CHARS);
    } catch (error) {
      detail = `<unreadable: ${error?.name || "error"}>`;
    } finally {
      clearTimeout(timer);
    }
    console.error(`${provider.name} API error`, response.status, detail);

    if (isContentRejection(response.status, detail)) {
      return { ok: false, status: 400, contentRejected: true, provider: provider.name, attempts, release: () => {} };
    }

    attempts.push({
      provider: provider.name,
      status: response.status,
      retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
      detail,
    });
  }

  // A 429 anywhere in the chain is the more actionable diagnosis: those services are
  // up and it is the quota that ran out, which is what the visitor message and the
  // admin throttle counter both key on.
  const rateLimited = attempts.find((attempt) => attempt.status === 429);
  return { ok: false, ...(rateLimited || attempts[0] || { status: 502 }), attempts, release: () => {} };
}

const OPEN_TAG = "<thought>";
const CLOSE_TAG = "</thought>";

// Longest suffix of `text` that could still grow into `tag` on the next chunk. Held
// back rather than emitted, so a "<thou" split across an SSE boundary never reaches
// the visitor as literal text.
function partialTagLength(text, tag) {
  const max = Math.min(text.length, tag.length - 1);
  for (let size = max; size > 0; size -= 1) {
    if (tag.startsWith(text.slice(text.length - size))) return size;
  }
  return 0;
}

// Splits Gemma's inline <thought> blocks out of the content channel, incrementally,
// so streaming works. Providers that separate reasoning properly never trip it.
export function createThoughtFilter() {
  let buffer = "";
  let inThought = false;
  let reasoning = "";

  return {
    push(text) {
      buffer += text;
      let visible = "";
      for (;;) {
        if (inThought) {
          const close = buffer.indexOf(CLOSE_TAG);
          if (close === -1) {
            const hold = partialTagLength(buffer, CLOSE_TAG);
            reasoning += buffer.slice(0, buffer.length - hold);
            buffer = buffer.slice(buffer.length - hold);
            return visible;
          }
          reasoning += buffer.slice(0, close);
          buffer = buffer.slice(close + CLOSE_TAG.length);
          inThought = false;
          continue;
        }
        const open = buffer.indexOf(OPEN_TAG);
        if (open === -1) {
          const hold = partialTagLength(buffer, OPEN_TAG);
          visible += buffer.slice(0, buffer.length - hold);
          buffer = buffer.slice(buffer.length - hold);
          return visible;
        }
        visible += buffer.slice(0, open);
        buffer = buffer.slice(open + OPEN_TAG.length);
        inThought = true;
      }
    },
    // Whatever is still held back at end of stream: safe to show unless we are inside
    // an unterminated thought, in which case the model was cut off mid-reasoning.
    flush() {
      const rest = buffer;
      buffer = "";
      if (inThought) {
        reasoning += rest;
        return "";
      }
      return rest;
    },
    reasoning() {
      return reasoning;
    },
  };
}

export const budgetsForTests = {
  total: TOTAL_BUDGET_MS,
  streamHeader: STREAM_HEADER_TIMEOUT_MS,
  nonStream: NON_STREAM_TIMEOUT_MS,
  minAttempt: MIN_ATTEMPT_MS,
  providerCount: PROVIDERS.length,
};
