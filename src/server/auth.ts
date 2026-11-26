import "./only";
import { createServerClient, parseCookieHeader, serializeCookieHeader, type CookieOptions } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { AppConfig } from "./config";
import { Fault, assert } from "./errors";
import { databaseFault } from "./database-errors";
import type { SessionUser } from "../contracts";

export function createPublicClient(config: AppConfig): SupabaseClient {
  return createClient(config.supabaseUrl, config.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (input, init) => fetch(input, { ...init, cache: "no-store", signal: AbortSignal.timeout(8000) }) },
  });
}

// Route handlers own session reads/writes. No browser SDK or global session singleton.
export function createSession(request: Request, config: AppConfig) {
  const values = new Map(parseCookieHeader(request.headers.get("cookie") ?? "").map(c => [c.name, c.value ?? ""]));
  const outgoing = new Map<string, { name: string; value: string; options: CookieOptions }>();
  const cacheHeaders = new Headers({ "Cache-Control": "private, no-store", Pragma: "no-cache", Expires: "0" });
  const client = createServerClient(config.supabaseUrl, config.publishableKey, {
    cookieOptions: { httpOnly: true, secure: true, sameSite: "lax", path: "/" },
    cookies: {
      getAll() { return [...values].map(([name, value]) => ({ name, value })); },
      setAll(cookies, headers) {
        for (const c of cookies) { values.set(c.name, c.value); outgoing.set(c.name, c); }
        for (const [name, value] of Object.entries(headers ?? {})) cacheHeaders.set(name, value);
      },
    },
    global: { fetch: (input, init) => fetch(input, { ...init, cache: "no-store", signal: AbortSignal.timeout(8000) }) },
  });
  return {
    client,
    apply(response: Response) {
      for (const [name, value] of cacheHeaders) response.headers.set(name, value);
      for (const c of outgoing.values()) response.headers.append("Set-Cookie", serializeCookieHeader(c.name, c.value, c.options));
      return response;
    },
    async requireUser(): Promise<SessionUser> {
      // A fresh server-confirmed user record; never authorize from getSession's unverified cookie.
      const { data, error } = await client.auth.getUser();
      if (error && (error.status ?? 500) >= 500) throw new Fault(503, "AUTH_UNAVAILABLE", "Layanan login belum dapat dijangkau.");
      assert(!error && data.user, 401, "AUTH_REQUIRED", "Sesi berakhir. Silakan login kembali.");
      const { data: membership, error: memberError } = await client.from("qa_members").select("active").eq("user_id", data.user.id).maybeSingle();
      if (memberError) throw databaseFault(memberError);
      assert(membership?.active === true, 403, "MEMBERSHIP_REQUIRED", "Akun belum diizinkan mengakses Dashboard QA.");
      return { id: data.user.id, email: data.user.email ?? null };
    },
  };
}
export type Session = ReturnType<typeof createSession>;
