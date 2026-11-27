import "./only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createJobSchema, loginSchema, passwordSchema, uuidSchema } from "../contracts";
import { createPublicClient, createSession, type Session } from "./auth";
import { readConfig, readWebhookConfig } from "./config";
import { body, parse, rawJsonBody, trustedHost, trustedRequest } from "./boundary";
import { Fault, assert } from "./errors";
import { Store } from "./store";
import { Service } from "./service";
import { WebhookDispatcher, verifyAuthenticatedCallback } from "./webhook";

import { requestUrl } from "../contracts/requests";
import { artifactPath, artifactToken, bindArtifactUploads, deliverableProgress, downloadArtifact, jobArtifacts, uploadArtifact } from "./artifacts";
import { discoverLinks } from "./discovery";
import { handleDrafts, REQUEST_SCOPE_MARKER, submittedRequest } from "./requests";

const empty = z.strictObject({});
export async function handleRequest(request: Request): Promise<Response> {
  const requestId = randomUUID(); let session: Session | undefined;
  const headers = { "Cache-Control": "private, no-store", "X-QA-Mode": "simulation", "X-QA-Storage": "supabase",
    "X-QA-Notice": "SIMULASI AGENT - bukan integrasi QA OpenBot; penyimpanan Supabase", "X-Request-Id": requestId };
  const reply = (value: unknown, status = 200) => Response.json(value, { status, headers });
  try {
    const config = readConfig();
    const url = new URL(request.url);
    if (url.pathname === "/api/v1/callbacks/qa") {
      trustedHost(request, config.origin);
      assert(!url.search, 400, "INVALID_REQUEST", "Parameter query tidak didukung.");
      assert(request.method === "POST", 405, "METHOD_NOT_ALLOWED", "Method tidak diizinkan.");
      const webhookConfig = readWebhookConfig();
      const { rawBytes, json } = await rawJsonBody(request);
      const { event, callbackToken } = verifyAuthenticatedCallback({
        webhookConfig,
        timestampHeader: request.headers.get("x-qa-timestamp"),
        signatureHeader: request.headers.get("x-qa-signature"),
        rawBody: rawBytes,
        parsedJson: json,
      });
      const store = new Store(createPublicClient(config));
      return reply(await store.agentCallback(callbackToken, event), 200);
    }
    const artifactMatch = url.pathname.match(/^\/api\/v1\/callbacks\/qa\/([^/]+)\/executions\/([^/]+)\/deliverables\/([^/]+)$/);
    if (artifactMatch) {
      trustedHost(request, config.origin);
      assert(!url.search, 400, "INVALID_REQUEST", "Parameter query tidak didukung.");
      assert(request.method === "PUT", 405, "METHOD_NOT_ALLOWED", "Method tidak diizinkan.");
      const [jobId, executionId, itemId] = parse(z.tuple([uuidSchema, uuidSchema, uuidSchema]), artifactMatch.slice(1));
      return reply(await uploadArtifact(request, config, jobId, executionId, itemId));
    }
    if (url.pathname.startsWith("/api/v1/callbacks/")) {
      trustedHost(request, config.origin);
      throw new Fault(503, "CALLBACK_DISABLED", "Callback simulator dinonaktifkan. Gunakan endpoint callback QA resmi.");
    }
    trustedRequest(request, config.origin);
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
    const store = new Store(session.client);
    if (url.pathname === "/api/v1/discovery") {
      assert(request.method === "POST", 405, "METHOD_NOT_ALLOWED", "Method tidak diizinkan.");
      const { targetUrl } = await body(request, z.strictObject({ targetUrl: requestUrl }));
      return send({ candidates: await discoverLinks(targetUrl) });
    }
    const draftMatch = url.pathname.match(/^\/api\/v1\/drafts(?:\/([^/]+)(?:\/(submit))?)?$/);
    if (draftMatch) {
      const draftId = draftMatch[1] ? parse(uuidSchema, draftMatch[1]) : undefined;
      const result = await handleDrafts(request, session.client, draftId, Boolean(draftMatch[2]));
      return send(result.payload, result.status);
    }
    const resultsMatch = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)\/deliverables(?:\/([^/]+))?$/);
    if (resultsMatch) {
      assert(request.method === "GET", 405, "METHOD_NOT_ALLOWED", "Method tidak diizinkan.");
      const jobId = parse(uuidSchema, resultsMatch[1]);
      if (resultsMatch[2]) {
        const itemId = parse(uuidSchema, resultsMatch[2]);
        return session.apply(await downloadArtifact(session.client, config, user.id, jobId, itemId));
      }
      const job = await store.job(jobId);
      const details = job.scope === REQUEST_SCOPE_MARKER ? await submittedRequest(session.client, jobId) : null;
      return send({ request: details, ...(await deliverableProgress(session.client, job)) });
    }
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
        // Validate webhook configuration BEFORE claiming DB lease so job stays not_sent if unconfigured.
        const webhookConfig = readWebhookConfig();
        const service = new Service(store, new WebhookDispatcher(config.origin, webhookConfig));
        const job = await service.dispatch(id, match[2] as "dispatch" | "retry" | "reconcile", async (current, token) => {
          if (current.scope !== REQUEST_SCOPE_MARKER) return;
          const details = await submittedRequest(store.client, id);
          assert(details, 503, "REQUESTS_UNCONFIGURED", "Data permintaan belum tersedia.");
          const items = await jobArtifacts(store.client, current);
          assert(items.length === details.deliverables.length, 503, "REQUESTS_UNCONFIGURED", "Daftar deliverable belum tersedia.");
          await bindArtifactUploads(store.client, current, items, webhookConfig.callbackKeyMaterial);
          return {
            accessRequiresLogin: details.accessRequiresLogin, accessNotes: details.accessNotes,
            environment: details.environment, scopeUrls: details.scopeUrls,
            suggestions: details.suggestions, prohibitions: details.prohibitions,
            securityPolicy: "defensive_only",
            deliverables: items.map(item => ({
              deliverableId: item.deliverable_id, kind: item.kind,
              uploadUrl: config.origin + artifactPath(current.jobId, current.executionId, item.deliverable_id),
              uploadToken: artifactToken(token, item.deliverable_id),
            })),
          };
        });
        return send({ job }, 202);
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
