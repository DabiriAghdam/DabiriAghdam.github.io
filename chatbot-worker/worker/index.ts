import handler from "vinext/server/app-router-entry";
import { handleAdminRequest } from "../lib/admin.js";
import { handleChatRequest } from "../lib/chat.js";

interface Env {
  ASSETS: Fetcher;
  DB?: D1Database;
  GROQ_API_KEY?: string;
  MODEL?: string;
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
      return Response.json({ ok: true, configured: Boolean(env.GROQ_API_KEY) });
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
