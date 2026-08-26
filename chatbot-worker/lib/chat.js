import { resetAuditForTests, updateAuditStatus, writeAuditMessage } from "./audit.js";
import { enforceRateLimit, resetRateLimitsForTests as resetRateLimitState, VISITOR_MINUTE_LIMIT } from "./rate-limit.js";
import { buildSystemPrompt } from "./context/index.js";
import { recordThrottle } from "./throttle.js";
import { activeProviders, callChatProvider, createThoughtFilter, providerLabel } from "./providers.js";

const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_MODEL = "openai/gpt-oss-20b";
const PROMPT_GUARD_MODEL = "meta-llama/llama-prompt-guard-2-22m";
const SAFETY_REJECTION = "I can't help with requests";
const DEFAULT_ORIGINS = "https://dabiriaghdam.github.io,http://localhost:4000,http://127.0.0.1:4000";
const MAX_MESSAGES = 8;
const MAX_USER_MESSAGE_LENGTH = 400;
// Paper summaries can be longer than ordinary replies. Keep enough room for
// several recent turns while still bounding untrusted request size.
const MAX_ASSISTANT_MESSAGE_LENGTH = 3600;
const MAX_CONVERSATION_LENGTH = 13_000;
const MAX_REQUEST_BYTES = 17_000;
const MAX_COMPLETION_TOKENS = 800;
const SAFE_STARTER_QUESTIONS = new Set([
  "What does Amir research?",
  "Summarize his background",
  "Where can I find his publications?",
  "Is Amir open to collaborations?",
  "Can I invite Amir to speak?",
  "What languages does Amir speak?",
  "What does Amir do outside research?",
]);
const BLOCKED_INPUT_PATTERNS = [
  /\b(?:ignore|disregard|override|forget)\b.{0,80}\b(?:instructions|prompt|rules)\b/i,
  /\b(?:reveal|show|print|repeat|leak|extract)\b.{0,80}\b(?:system prompt|developer message|api key|secret|hidden instructions)\b/i,
  /\b(?:jailbreak|developer mode|prompt injection)\b/i,
];


function corsHeaders(origin, allowedOrigins) {
  const headers = new Headers({
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Vary": "Origin",
    "X-Content-Type-Options": "nosniff",
  });
  if (allowedOrigins.has(origin)) headers.set("Access-Control-Allow-Origin", origin);
  return headers;
}

function requestLocation(request, ipAddress) {
  const cf = request.cf || {};
  const header = (name) => request.headers.get(name) || "";
  const value = (candidate, fallback = "") => String(candidate ?? fallback).trim().slice(0, 120) || null;
  // Cloudflare omits these outside its geo-enabled paths, and header() yields "".
  // Number("") is 0, which is finite and in range, so a blank would otherwise be
  // stored as a convincing "0.00000" and pin the visitor to Null Island.
  const coordinate = (candidate, fallback, maxAbs) => {
    const raw = candidate ?? fallback;
    if (raw === null || raw === undefined) return null;
    const text = String(raw).trim();
    if (!text) return null;
    const parsed = Number(text);
    return Number.isFinite(parsed) && parsed >= -maxAbs && parsed <= maxAbs ? parsed.toFixed(5) : null;
  };
  return {
    ipAddress,
    country: value(cf.country, header("CF-IPCountry")),
    region: value(cf.region, header("CF-IPRegion")),
    city: value(cf.city, header("CF-IPCity")),
    latitude: coordinate(cf.latitude, header("CF-IPLatitude"), 90),
    longitude: coordinate(cf.longitude, header("CF-IPLongitude"), 180),
  };
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers });
}

function streamHeaders(headers) {
  const result = new Headers(headers);
  result.set("Cache-Control", "no-cache, no-transform");
  result.set("Connection", "keep-alive");
  result.set("Content-Type", "text/event-stream; charset=utf-8");
  result.set("X-Accel-Buffering", "no");
  return result;
}

function serverEvent(event, payload) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function processProviderEventLine(line, onDelta, onReasoning, onFinish, onModel) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(":")) return false;
  if (!trimmed.startsWith("data:")) return false;
  const payload = trimmed.slice(5).trim();
  if (!payload) return false;
  if (payload === "[DONE]") return true;
  try {
    const parsed = JSON.parse(payload);
    if (typeof parsed.model === "string" && parsed.model) onModel(parsed.model);
    const choice = parsed.choices?.[0];
    if (typeof choice?.finish_reason === "string") onFinish(choice.finish_reason);
    const delta = choice?.delta?.content;
    if (typeof delta === "string" && delta) onDelta(delta);
    const reasoning = choice?.delta?.reasoning ?? choice?.delta?.reasoning_content;
    if (typeof reasoning === "string" && reasoning) onReasoning(reasoning);
  } catch {
    // Ignore malformed/unknown provider events and wait for the next chunk.
  }
  return false;
}

function streamProviderResponse(providerResponse, {
  headers,
  env,
  provider,
  release,
  userAuditId,
  auditEntry,
  question,
  ctx,
}) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let reader;
  let fullMessage = "";
  let fullReasoning = "";
  let buffer = "";
  let completed = false;
  let finishReason = null;
  // Gemma emits its chain-of-thought inline in the content channel; every other
  // provider separates it, and for those the filter is a pass-through.
  const thoughts = createThoughtFilter();
  let servedModel = provider.model;

  const body = new ReadableStream({
    async start(controller) {
      const emitError = async (message, status = 502) => {
        release?.();
        try {
          await updateAuditStatus(env.DB, userAuditId, "model-error");
        } catch (error) {
          console.error("Audit status update failed", error);
        }
        controller.enqueue(encoder.encode(serverEvent("error", { error: message, status })));
        controller.close();
      };

      // Hoisted so the stall path below can reach it: a truncated answer the visitor
      // has already read must still be recorded, or the dashboard shows a question
      // with no reply and the turn looks like a failure that never happened.
      const persistAssistantAudit = async (message, truncated) => {
        try {
          await writeAuditMessage(env.DB, {
            ...auditEntry,
            model: providerLabel(provider.name, servedModel),
            role: "assistant",
            content: message,
            reasoning: fullReasoning.trim() || null,
            status: truncated ? "truncated" : "accepted",
            createdAt: Date.now(),
          });
        } catch (error) {
          // Do not discard a completed answer just because audit storage is unavailable.
          console.error("Assistant audit storage unavailable", error);
        }
      };
      const settleAudit = async (message, truncated) => {
        settled = true;
        const pending = persistAssistantAudit(message, truncated);
        if (ctx?.waitUntil) ctx.waitUntil(pending);
        else await pending;
      };

      // The terminal event and the audit write must happen exactly once. Without this
      // a controller.close() that throws — a visitor who navigated away mid-answer —
      // would fall into the catch below and replay the whole ending on a dead stream.
      let settled = false;

      const onDelta = (delta) => {
        const visible = thoughts.push(delta);
        if (!visible) return;
        fullMessage += visible;
        controller.enqueue(encoder.encode(serverEvent("delta", { text: visible })));
      };
      const onReasoning = (reasoning) => { fullReasoning += reasoning; };
      const onFinish = (reason) => { finishReason = reason; };
      const onModel = (name) => { servedModel = name; };

      try {
        reader = providerResponse.body?.getReader();
        if (!reader) {
          await emitError("The assistant returned an empty response.");
          return;
        }

        while (!completed) {
          const { done, value } = await reader.read();
          buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || "";
          for (const line of lines) {
            if (processProviderEventLine(line, onDelta, onReasoning, onFinish, onModel)) {
              completed = true;
              break;
            }
          }
          if (done) break;
        }

        if (!completed && buffer) {
          processProviderEventLine(buffer, onDelta, onReasoning, onFinish, onModel);
        }

        const trailing = thoughts.flush();
        if (trailing) {
          fullMessage += trailing;
          controller.enqueue(encoder.encode(serverEvent("delta", { text: trailing })));
        }
        fullReasoning += thoughts.reasoning();

        release?.();

        const message = fullMessage.trim();
        if (!message) {
          await updateAuditStatus(env.DB, userAuditId, "empty-response");
          controller.enqueue(encoder.encode(serverEvent("error", { error: "The assistant returned an empty response.", status: 502 })));
          controller.close();
          return;
        }

        const truncated = finishReason === "length";
        const terminalEvent = encoder.encode(serverEvent("done", {
          followUpQuestions: suggestFollowUps(question, message),
          sources: sourceLinks(question, message),
          truncated,
        }));
        settled = true;
        controller.enqueue(terminalEvent);
        controller.close();
        await settleAudit(message, truncated);
      } catch (error) {
        console.error("Provider stream failed", error);
        if (settled) return;
        // A stall abort after the answer already started is not worth discarding: the
        // visitor has the text on screen, so close the turn as truncated instead of
        // replacing a partial answer with an error.
        const partial = `${fullMessage}${thoughts.flush()}`.trim();
        // Same order as the normal path: the filter's reasoning is only complete once
        // flush() has run, and without this the stored turn loses it.
        fullReasoning += thoughts.reasoning();
        if (partial) {
          release?.();
          controller.enqueue(encoder.encode(serverEvent("done", {
            followUpQuestions: suggestFollowUps(question, partial),
            sources: sourceLinks(question, partial),
            truncated: true,
          })));
          controller.close();
          await settleAudit(partial, true);
          return;
        }
        await emitError("The assistant is temporarily unavailable.");
      }
    },
    async cancel(reason) {
      release?.();
      try {
        await reader?.cancel(reason);
      } catch {
        // The client disconnected; there is nothing else to send.
      }
    },
  });

  return new Response(body, { status: 200, headers: streamHeaders(headers) });
}

function validateMessages(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MESSAGES) return null;
  const messages = [];
  let totalLength = 0;

  for (const [index, item] of value.entries()) {
    if (!item || !["user", "assistant"].includes(item.role) || typeof item.content !== "string") return null;
    const content = item.content.trim();
    const maxLength = item.role === "user" ? MAX_USER_MESSAGE_LENGTH : MAX_ASSISTANT_MESSAGE_LENGTH;
    if (!content || content.length > maxLength) return null;
    if (index === 0 && item.role !== "user") return null;
    if (index > 0 && messages[index - 1].role === item.role) return null;
    totalLength += content.length;
    if (totalLength > MAX_CONVERSATION_LENGTH) return null;
    messages.push({ role: item.role, content });
  }

  if (messages.at(-1)?.role !== "user") return null;
  return messages;
}

function inputRejection(messages) {
  const latest = messages.at(-1).content;
  if (BLOCKED_INPUT_PATTERNS.some((pattern) => pattern.test(latest))) {
    return SAFETY_REJECTION;
  }
  if ((latest.match(/https?:\/\//gi) || []).length > 2 || /(.)\1{14,}/u.test(latest)) {
    return "Please send a short, plain-text question about Amir's work.";
  }
  return null;
}

function isSafeStarterQuestion(content) {
  return SAFE_STARTER_QUESTIONS.has(content);
}

async function promptGuardRejects(content, apiKey) {
  const response = await fetch(GROQ_CHAT_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: PROMPT_GUARD_MODEL,
      messages: [{ role: "user", content }],
      max_completion_tokens: 24,
      temperature: 0,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Prompt Guard returned ${response.status}.`);

  const result = await response.json();
  const verdict = result.choices?.[0]?.message?.content?.trim().toLowerCase();
  if (!verdict) throw new Error("Prompt Guard returned an empty verdict.");
  if (/^(?:1|label_1|malicious|unsafe)\b/.test(verdict) || /(?:jailbreak|prompt injection)/.test(verdict)) return true;
  if (/^(?:0|label_0|benign|safe)\b/.test(verdict)) return false;
  throw new Error("Prompt Guard returned an unrecognized verdict.");
}

function suggestFollowUps(question, answer) {
  const context = `${question} ${answer}`.toLowerCase();
  if (/collaborat|speaking|speaker|invitation|invite|guest lecture|seminar|workshop|panel|talk/.test(context)) {
    return [
      "What research topics could Amir discuss?",
      "How can I contact Amir about a collaboration?",
      "What is Amir currently researching?",
    ];
  }
  if (/publication|paper|published|conference|journal/.test(context)) {
    return [
      "What topics do his publications cover?",
      "Where can I read his publications?",
      "What is Amir currently researching?",
    ];
  }
  if (/background|education|degree|university|ubc|tehran|epfl/.test(context)) {
    return [
      "What did Amir work on at EPFL?",
      "Who supervises his Ph.D.?",
      "What are his main research interests?",
    ];
  }
  if (/language|speak|hobby|karate|outside academics/.test(context)) {
    return [
      "What languages does Amir speak?",
      "What does Amir do outside research?",
      "What are Amir's main research interests?",
    ];
  }
  if (/research|machine learning|reinforcement|language model|llm|nlp|agent/.test(context)) {
    return [
      "What does he study about LLM agents?",
      "Where can I find his publications?",
      "Who supervises his research?",
    ];
  }
  return [
    "What does Amir research?",
    "Summarize his academic background",
    "Where can I find his publications?",
  ];
}

function sourceLinks(question, answer) {
  const context = `${question} ${answer}`.toLowerCase();
  const sources = [
    { label: "CV", url: "https://dabiriaghdam.github.io/assets/pdf/Dabiriaghdam_CV.pdf" },
    { label: "Publications", url: "https://dabiriaghdam.github.io/publications/" },
  ];
  const papers = [
    [/(master'?s thesis|combating disinformation|watermarking llms to persuasion)/, "Master's thesis", "https://open.library.ubc.ca/media/download/pdf/24/1.0449874/3"],
    [/(unpredictabench|distributional randomness|ks@100|ks@n)/, "UnpredictaBench", "https://unpredictabenchmark.github.io/"],
    [/(vamps|visual-assisted mathematical|graph-assisted math)/, "VAMPS", "https://vampsbench.github.io/"],
    [/(minor edits matter|medical vlm|ultrasound prompt|prompt attack.*ultrasound)/, "When Minor Edits Matter", "https://sonopromptattack.github.io/"],
    [/(simmark|watermark)/, "SimMark", "https://simmark-llm.github.io/"],
    [/(soi matters|subsets? of interest|multi-setting|training dynamics)/, "SOI Matters", "https://aclanthology.org/2025.mrl-main.21/"],
    [/(persuasion|meme|semeval|bcamirs)/, "BcAmirs at SemEval", "https://aclanthology.org/2024.semeval-1.203/"],
    [/(adversarial attack|neural machine translation|translation model)/, "Adversarial attacks paper", "https://adversarialattacknmt.github.io/"],
  ];
  const paper = papers.find(([pattern]) => pattern.test(context));
  if (paper) sources.push({ label: paper[1], url: paper[2] });
  return sources;
}

export function resetRateLimitsForTests() {
  resetRateLimitState();
  resetAuditForTests();
}

export async function handleChatRequest(request, env, ctx) {
  const origin = request.headers.get("Origin") || "";
  const allowedOrigins = new Set((env.ALLOWED_ORIGINS || DEFAULT_ORIGINS).split(",").map((item) => item.trim()).filter(Boolean));
  const headers = corsHeaders(origin, allowedOrigins);
  const wantsStream = (request.headers.get("Accept") || "").toLowerCase().includes("text/event-stream");

  if (!allowedOrigins.has(origin)) return json({ error: "Origin not allowed." }, 403, headers);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405, headers);
  if (!env.GROQ_API_KEY) return json({ error: "The assistant is not configured." }, 503, headers);
  if (!(request.headers.get("Content-Type") || "").toLowerCase().startsWith("application/json")) {
    return json({ error: "Content-Type must be application/json." }, 415, headers);
  }
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > MAX_REQUEST_BYTES) return json({ error: "The request is too large." }, 413, headers);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON." }, 400, headers);
  }

  if (JSON.stringify(body).length > MAX_REQUEST_BYTES) return json({ error: "The request is too large." }, 413, headers);

  const messages = validateMessages(body.messages);
  if (!messages) return json({ error: "Invalid conversation." }, 400, headers);
  const suppliedSessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  const sessionId = /^[a-zA-Z0-9_-]{16,64}$/.test(suppliedSessionId) ? suppliedSessionId : crypto.randomUUID();
  const latestMessage = messages.at(-1).content;

  const visitorKey = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For")?.split(",")[0].trim() || "unknown-visitor";
  const location = requestLocation(request, visitorKey);
  let rateLimit;
  try {
    rateLimit = await enforceRateLimit(env.DB, visitorKey);
  } catch (error) {
    console.error("Rate limiter unavailable", error);
    return json({ error: "The assistant is temporarily unavailable." }, 503, headers);
  }
  if (!rateLimit.allowed) {
    headers.set("Retry-After", String(rateLimit.retryAfter));
    // Nothing was written to the audit log on this path, so without this counter a
    // visitor turned away at the door leaves no trace at all and the assistant can
    // look healthy while being unusable.
    const kind = rateLimit.reason === "capacity"
      ? "site-capacity"
      : rateLimit.reason === "day" ? "visitor-day" : "visitor-minute";
    await recordThrottle(env.DB, kind);
    const error = rateLimit.reason === "capacity"
      ? "The assistant has reached today's capacity. Please try again tomorrow."
      : rateLimit.reason === "day"
        ? "You've reached today's question limit. Please try again tomorrow."
        : "Too many messages. Please wait a minute and try again.";
    return json({ error }, 429, headers);
  }
  headers.set("RateLimit-Limit", String(VISITOR_MINUTE_LIMIT));
  headers.set("RateLimit-Remaining", String(rateLimit.remainingMinute));

  // Provisional: the user row is written before the provider is chosen, so it records
  // the provider we intend to try first. The assistant row records who actually answered.
  const model = providerLabel(activeProviders(env)[0]?.name || "groq", env.MODEL || DEFAULT_MODEL);
  let userAuditId;
  try {
    userAuditId = await writeAuditMessage(env.DB, {
      sessionId,
      visitorHash: rateLimit.visitorHash,
      role: "user",
      content: latestMessage,
      status: "pending",
      origin,
      model,
      ...location,
      createdAt: Date.now(),
    });
  } catch (error) {
    console.error("Audit storage unavailable", error);
    return json({ error: "The assistant is temporarily unavailable." }, 503, headers);
  }

  const rejectedInput = inputRejection(messages);
  if (rejectedInput) {
    await updateAuditStatus(env.DB, userAuditId, "blocked-local");
    return json({ error: rejectedInput }, 400, headers);
  }

  let guardSkipped = false;
  if (!isSafeStarterQuestion(latestMessage)) {
    try {
      if (await promptGuardRejects(latestMessage, env.GROQ_API_KEY)) {
        await updateAuditStatus(env.DB, userAuditId, "blocked-guard");
        return json({ error: SAFETY_REJECTION }, 400, headers);
      }
    } catch (error) {
      // Fail open. Prompt Guard runs on Groq, so a Groq outage would otherwise stop
      // the request here and the fallback chain below would never be reached — the
      // outage the chain exists to survive would be the one thing that defeats it.
      // The local BLOCKED_INPUT_PATTERNS check above has already run and still
      // applies, and the turn is recorded as "guard-error" so the dashboard shows
      // exactly which answers went out without the model-based check.
      console.error("Prompt Guard unavailable, proceeding without it", error);
      guardSkipped = true;
      await updateAuditStatus(env.DB, userAuditId, "guard-error");
    }
  }

  if (!guardSkipped) await updateAuditStatus(env.DB, userAuditId, "accepted");

  const attempt = await callChatProvider(env, {
    messages,
    systemPrompt: buildSystemPrompt(),
    wantsStream,
    maxCompletionTokens: MAX_COMPLETION_TOKENS,
  });

  if (!attempt.ok) {
    // A moderation refusal is a judgement on the prompt, not on the provider, so the
    // chain has already stopped rather than shopping the same flagged text around.
    if (attempt.contentRejected) {
      await updateAuditStatus(env.DB, userAuditId, "blocked-provider");
      return json({ error: SAFETY_REJECTION }, 400, headers);
    }
    await updateAuditStatus(env.DB, userAuditId, "model-error");
    if (attempt.status !== 429) {
      return json({ error: "The assistant is temporarily unavailable." }, 502, headers);
    }
    // A burst against the per-minute token ceiling clears in seconds; an exhausted
    // daily budget does not, and telling someone to "wait a moment" for something
    // that returns tomorrow just earns a string of failed retries.
    const waitsHours = Number.isFinite(attempt.retryAfter) && attempt.retryAfter > 900;
    await recordThrottle(env.DB, waitsHours ? "upstream-exhausted" : "upstream-busy");
    if (Number.isFinite(attempt.retryAfter) && attempt.retryAfter > 0) {
      headers.set("Retry-After", String(Math.ceil(attempt.retryAfter)));
    }
    return json({
      error: waitsHours
        ? "The assistant has reached today's usage limit. Please try again tomorrow, or contact Amir directly."
        : "The assistant is busy right now. Please wait a moment and try again.",
    }, 429, headers);
  }

  const { response: providerResponse, provider, release } = attempt;

  if (wantsStream) {
    return streamProviderResponse(providerResponse, {
      headers,
      env,
      provider,
      release,
      userAuditId,
      auditEntry: {
        sessionId,
        visitorHash: rateLimit.visitorHash,
        origin,
        model,
        ...location,
      },
      question: latestMessage,
      ctx,
    });
  }

  let result;
  try {
    result = await providerResponse.json();
  } catch (error) {
    // Aborted by the shared deadline, or truncated mid-body.
    console.error("Provider response was unreadable", error);
    await updateAuditStatus(env.DB, userAuditId, "model-error");
    return json({ error: "The assistant is temporarily unavailable." }, 502, headers);
  } finally {
    release();
  }
  const assistantMessage = result.choices?.[0]?.message || {};
  const thoughts = createThoughtFilter();
  const message = typeof assistantMessage.content === "string"
    ? thoughts.push(assistantMessage.content) + thoughts.flush()
    : assistantMessage.content;
  const separateReasoning = typeof assistantMessage.reasoning === "string"
    ? assistantMessage.reasoning
    : typeof assistantMessage.reasoning_content === "string"
      ? assistantMessage.reasoning_content
      : "";
  const reasoning = `${separateReasoning}${thoughts.reasoning()}`.trim();
  if (typeof message !== "string" || !message.trim()) {
    await updateAuditStatus(env.DB, userAuditId, "empty-response");
    return json({ error: "The assistant returned an empty response." }, 502, headers);
  }
  const truncated = result.choices?.[0]?.finish_reason === "length";
  await writeAuditMessage(env.DB, {
    sessionId,
    visitorHash: rateLimit.visitorHash,
    role: "assistant",
    content: message.trim(),
    reasoning: reasoning || null,
    status: truncated ? "truncated" : "accepted",
    origin,
    model: providerLabel(provider.name, typeof result.model === "string" && result.model ? result.model : provider.model),
    ...location,
    createdAt: Date.now(),
  });
  return json({
    message: message.trim(),
    followUpQuestions: suggestFollowUps(latestMessage, message),
    sources: sourceLinks(latestMessage, message),
    truncated,
  }, 200, headers);
}
