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
