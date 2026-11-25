import "./only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createJobSchema, loginSchema, passwordSchema, uuidSchema } from "../contracts";
import { createSession, type Session } from "./auth";
import { readConfig } from "./config";
import { body, parse, trustedRequest } from "./boundary";
import { Fault, assert } from "./errors";
import { Store } from "./store";
import { Simulator } from "./simulator";
import { Service } from "./service";

const empty = z.strictObject({});
export async function handleRequest(request: Request): Promise<Response> {
  const requestId = randomUUID(); let session: Session | undefined;
  const headers = { "Cache-Control": "private, no-store", "X-QA-Mode": "simulation", "X-QA-Storage": "supabase",
    "X-QA-Notice": "SIMULASI AGENT - bukan integrasi QA OpenBot; penyimpanan Supabase", "X-Request-Id": requestId };
  const reply = (value: unknown, status = 200) => Response.json(value, { status, headers });
  try {
    const config = readConfig(); trustedRequest(request, config.origin);
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/v1/callbacks/")) throw new Fault(503, "CALLBACK_DISABLED", "Callback eksternal belum diaktifkan. Simulator menggunakan jalur internal.");
    assert(url.pathname === "/api/v1/auth/confirm" || !url.search, 400, "INVALID_REQUEST", "Parameter query tidak didukung.");
    session = createSession(request, config);
    const send = (value: unknown, status = 200) => session!.apply(reply(value, status));
    if (url.pathname === "/api/v1/auth/login" && request.method === "POST") {
      const input = await body(request, loginSchema);
      const { error } = await session.client.auth.signInWithPassword(input);
      if (error && (error.status ?? 500) >= 500) throw new Fault(503, "AUTH_UNAVAILABLE", "Layanan login belum dapat dijangkau.");
      assert(!error, 401, "INVALID_CREDENTIALS", "Login gagal. Periksa akun atau hubungi operator.");
      try {
        const user = await session.requireUser();
        return send({ user, mode: "simulation", storage: "supabase" });
      } catch (error) {
        await session.client.auth.signOut({ scope: "local" }); throw error;
      }
    }
    if (url.pathname === "/api/v1/auth/logout" && request.method === "POST") {
      await body(request, empty);
      const { error } = await session.client.auth.signOut({ scope: "local" });
      assert(!error, 503, "LOGOUT_UNAVAILABLE", "Logout belum dapat dikonfirmasi. Coba kembali.");
      return send({ signedOut: true });
    }
    if (url.pathname === "/api/v1/auth/confirm" && request.method === "GET") {
      const keys = [...url.searchParams.keys()];
      assert(keys.length === 2 && keys.includes("token_hash") && keys.includes("type") && url.searchParams.get("type") === "invite", 400, "INVALID_INVITE", "Tautan undangan tidak valid.");
      const token_hash = url.searchParams.get("token_hash") ?? "";
      assert(/^[A-Za-z0-9_-]{32,256}$/.test(token_hash), 400, "INVALID_INVITE", "Tautan undangan tidak valid.");
      const { error } = await session.client.auth.verifyOtp({ token_hash, type: "invite" });
      assert(!error, 400, "INVALID_INVITE", "Tautan undangan tidak valid atau kedaluwarsa.");
      await session.requireUser();
      return session.apply(new Response(null, { status: 303, headers: { ...headers, Location: config.origin + "/login?invited=1", "Referrer-Policy": "no-referrer" } }));
    }
    const user = await session.requireUser();
    if (url.pathname === "/api/v1/auth/session" && request.method === "GET") return send({ user, mode: "simulation", storage: "supabase" });
    if (url.pathname === "/api/v1/auth/password" && request.method === "POST") {
      const input = await body(request, passwordSchema);
      const { error } = await session.client.auth.updateUser(input);
      assert(!error, 400, "PASSWORD_UPDATE_FAILED", "Password belum diperbarui. Periksa kebijakan password atau hubungi operator.");
      return send({ updated: true });
    }
    const store = new Store(session.client), service = new Service(store, new Simulator(store));
    if (url.pathname === "/api/v1/jobs") {
      if (request.method === "GET") return send({ mode: "simulation", jobs: await store.list() });
      if (request.method === "POST") {
        const key = parse(uuidSchema, request.headers.get("idempotency-key"));
        const { job, replay } = await store.create(await body(request, createJobSchema), key);
        return send({ job }, replay ? 200 : 201);
      }
      throw new Fault(405, "METHOD_NOT_ALLOWED", "Method tidak diizinkan.");
    }
    const match = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)(?:\/(dispatch|retry|reconcile))?$/);
    if (match) {
      const id = parse(uuidSchema, match[1]);
      if (!match[2] && request.method === "GET") return send({ job: await store.job(id) });
      if (match[2] && request.method === "POST") {
        await body(request, empty);
        return send({ job: await service.dispatch(id, match[2] as "dispatch" | "retry" | "reconcile") }, 202);
      }
      throw new Fault(405, "METHOD_NOT_ALLOWED", "Method tidak diizinkan.");
    }
    throw new Fault(404, "ROUTE_NOT_FOUND", "Endpoint tidak ditemukan.");
  } catch (error) {
    const fault = error instanceof Fault ? error : new Fault(503, "SERVICE_UNAVAILABLE", "Layanan belum dapat dijangkau. Muat ulang sebelum mencoba lagi.");
    const response = reply({ error: { code: fault.code, message: fault.message, requestId } }, fault.status);
    response.headers.set("Referrer-Policy", "no-referrer");
    return session ? session.apply(response) : response;
  }
}
