import { PROMPT_INSTRUCTIONS } from "./instructions.js";
import { IDENTITY_CONTEXT } from "./identity.js";
import { PUBLICATIONS_CONTEXT } from "./publications.js";
import { EXPERIENCE_CONTEXT } from "./experience.js";
import { PERSONAL_CONTEXT } from "./personal.js";

// These are bundled as static modules rather than loaded through user-controlled
// filesystem tools. That keeps the knowledge base editable while preserving a
// small, read-only attack surface in the worker.
export const SYSTEM_PROMPT = [
  PROMPT_INSTRUCTIONS,
  IDENTITY_CONTEXT,
  PUBLICATIONS_CONTEXT,
  EXPERIENCE_CONTEXT,
  PERSONAL_CONTEXT,
].join("\n\n");

// Appended per request rather than baked into SYSTEM_PROMPT, and deliberately placed
// LAST: Groq's prompt caching keys on a shared prefix, so a value that changes daily
// has to sit after the static text or it would invalidate the cache every midnight.
// UTC keeps it deterministic regardless of where the visitor or the edge node is.
export function buildSystemPrompt(now = Date.now()) {
  const today = new Date(now).toISOString().slice(0, 10);
  return `${SYSTEM_PROMPT}\n\nToday is ${today} (UTC); use it for recency, never to infer Amir's age or birth date.`;
}
