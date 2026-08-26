import handler from "vinext/server/app-router-entry";
import { handleAdminRequest } from "../lib/admin.js";
import { handleChatRequest } from "../lib/chat.js";
import { activeProviders } from "../lib/providers.js";

interface Env {
  ASSETS: Fetcher;
  DB?: D1Database;
  GROQ_API_KEY?: string;
  MODEL?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_MODEL?: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  ALLOWED_ORIGINS?: string;
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD?: string;
  PUBLIC_SITE_URL?: string;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/chat") return handleChatRequest(request, env, ctx);
    if (["/admin", "/admin/export.json", "/admin/password", "/admin/delete-old"].includes(url.pathname)) {
      return handleAdminRequest(request, env);
    }
    if (url.pathname === "/health") {
      // Names only, never key material, and nothing here is not already public in the
      // repo. Reporting the live chain is what makes a missing fallback secret visible
      // from outside: without it a deploy that skipped `wrangler secret put` looks
      // exactly like a healthy one until a visitor hits an upstream 429.
      const providers = activeProviders(env).map((provider) => provider.name);
      return Response.json({ ok: true, configured: providers.length > 0, providers });
    }
    if (url.pathname === "/") {
      return new Response(null, {
        status: 302,
        headers: {
          "Cache-Control": "no-store",
          Location: env.PUBLIC_SITE_URL || "https://dabiriaghdam.github.io/",
        },
      });
    }
    return handler.fetch(request, env, ctx);
  },
};

export default worker;
