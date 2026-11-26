import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { callbackSchema, type Job } from "../src/contracts";
import { readWebhookConfig } from "../src/server/config";
import { Fault } from "../src/server/errors";
import { databaseFault } from "../src/server/database-errors";
import {
  WebhookDispatcher,
  buildOpenBotDispatchRequest,
  deriveCallbackToken,
  hashCallbackToken,
  signCallbackPayload,
  verifyAuthenticatedCallback,
} from "../src/server/webhook";
import { Service, type JobWebhookStore } from "../src/server/service";
import { handleRequest } from "../src/server/api";

const appOrigin = "https://qa.example.invalid";
const dummyWebhookUrl = "https://webhook.example.invalid/v1/webhooks/00000000-0000-4000-8000-000000000000";
const dummyWebhookSecret = "dummy-openbot-webhook-secret-example-only";
const dummyCallbackSecret = "dummy-callback-root-secret-example-only";

function makeDummyJob(overrides: Partial<Job> = {}): Job {
  return {
    schemaVersion: 1,
    jobId: "11111111-1111-4111-8111-111111111111",
    executionId: "22222222-2222-4222-8222-222222222222",
    mode: "simulation",
    targetUrl: "https://example.invalid/qa-target",
    scope: "Pemeriksaan alur login dummy",
    acceptanceCriteria: ["Halaman memuat judul utama", "Validasi form muncul saat kosong"],
    deliverables: ["summary", "checks", "findings"],
    createdAt: "2026-11-26T04:00:00.000Z",
    updatedAt: "2026-11-26T04:00:00.000Z",
    version: 1,
    deliveryStatus: "not_sent",
    executionStatus: "not_started",
    lastError: null,
    result: null,
    leaseExpiresAt: null,
    ...overrides,
  };
}

const failsWith = (fn: () => unknown, status: number, code: string) =>
  assert.throws(fn, (err: unknown) => err instanceof Fault && err.status === status && err.code === code);

test("readWebhookConfig validates HTTPS URL and secret with 503 WEBHOOK_UNCONFIGURED (never SETUP_REQUIRED)", () => {
  failsWith(() => readWebhookConfig({}), 503, "WEBHOOK_UNCONFIGURED");
  failsWith(() => readWebhookConfig({ QA_WEBHOOK_URL: dummyWebhookUrl }), 503, "WEBHOOK_UNCONFIGURED");
  failsWith(() => readWebhookConfig({ QA_WEBHOOK_URL: dummyWebhookUrl, QA_WEBHOOK_SECRET: "   " }), 503, "WEBHOOK_UNCONFIGURED");
  for (const invalidUrl of [
    "http://webhook.example.invalid/v1/webhooks/abc",
    "https://user:dummy@webhook.example.invalid/v1/webhooks/abc",
    "https://webhook.example.invalid/v1/webhooks/abc?query=1",
    "https://webhook.example.invalid/v1/webhooks/abc#frag",
    "https://webhook.example.invalid/v1/webhooks/abc ",
  ]) {
    failsWith(() => readWebhookConfig({ QA_WEBHOOK_URL: invalidUrl, QA_WEBHOOK_SECRET: dummyWebhookSecret }), 503, "WEBHOOK_UNCONFIGURED");
  }

  const derivedCfg = readWebhookConfig({ QA_WEBHOOK_URL: dummyWebhookUrl, QA_WEBHOOK_SECRET: dummyWebhookSecret });
  assert.equal(derivedCfg.webhookUrl, dummyWebhookUrl);
  assert.equal(derivedCfg.callbackKeyMaterial.byteLength, 32);
  assert.notEqual(Buffer.from(derivedCfg.callbackKeyMaterial).toString("utf8"), dummyWebhookSecret);

  const explicitCfg = readWebhookConfig({
    QA_WEBHOOK_URL: dummyWebhookUrl,
    QA_WEBHOOK_SECRET: dummyWebhookSecret,
    QA_CALLBACK_SECRET: dummyCallbackSecret,
  });
  const explicitRotatedWebhookCfg = readWebhookConfig({
    QA_WEBHOOK_URL: dummyWebhookUrl,
    QA_WEBHOOK_SECRET: "rotated-dummy-webhook-secret-example",
    QA_CALLBACK_SECRET: dummyCallbackSecret,
  });
  const job = makeDummyJob();
  const tDerived = deriveCallbackToken(derivedCfg.callbackKeyMaterial, job.jobId, job.executionId);
  const tExplicit1 = deriveCallbackToken(explicitCfg.callbackKeyMaterial, job.jobId, job.executionId);
  const tExplicit2 = deriveCallbackToken(explicitRotatedWebhookCfg.callbackKeyMaterial, job.jobId, job.executionId);
  assert.notEqual(tDerived, tExplicit1);
  assert.equal(tExplicit1, tExplicit2);
});

test("deriveCallbackToken and hashCallbackToken are deterministic per (jobId, executionId) and domain-separated", () => {
  const cfg = readWebhookConfig({ QA_WEBHOOK_URL: dummyWebhookUrl, QA_WEBHOOK_SECRET: dummyWebhookSecret });
  const job = makeDummyJob();
  const tokenA1 = deriveCallbackToken(cfg.callbackKeyMaterial, job.jobId, job.executionId);
  const tokenA2 = deriveCallbackToken(cfg.callbackKeyMaterial, job.jobId, job.executionId);
  const tokenOtherJob = deriveCallbackToken(cfg.callbackKeyMaterial, "33333333-3333-4333-8333-333333333333", job.executionId);
  const tokenOtherExec = deriveCallbackToken(cfg.callbackKeyMaterial, job.jobId, "44444444-4444-4444-8444-444444444444");

  assert.match(tokenA1, /^[0-9a-f]{64}$/);
  assert.equal(tokenA1, tokenA2);
  assert.notEqual(tokenA1, tokenOtherJob);
  assert.notEqual(tokenA1, tokenOtherExec);
  assert.equal(tokenA1.includes(dummyWebhookSecret), false);

  const expectedHash = createHash("sha256").update(tokenA1, "utf8").digest("hex");
  assert.equal(hashCallbackToken(tokenA1), expectedHash);
  assert.match(expectedHash, /^[0-9a-f]{64}$/);
});

test("buildOpenBotDispatchRequest produces exact OpenBot x-openbot-* headers and signed payload", () => {
  const cfg = readWebhookConfig({ QA_WEBHOOK_URL: dummyWebhookUrl, QA_WEBHOOK_SECRET: dummyWebhookSecret });
  const job = makeDummyJob();
  const callbackToken = deriveCallbackToken(cfg.callbackKeyMaterial, job.jobId, job.executionId);
  const fixedNow = Date.parse("2026-11-26T04:15:09.750Z");

  const req = buildOpenBotDispatchRequest({ appOrigin, webhookConfig: cfg, job, callbackToken, nowMs: fixedNow });
  assert.equal(req.url, dummyWebhookUrl);
  assert.equal(req.headers["Content-Type"], "application/json");
  assert.equal(req.headers["x-openbot-timestamp"], String(Math.floor(fixedNow / 1000)));
  assert.equal(req.headers["x-openbot-delivery-id"], `qa-exec:${job.executionId}`);
  assert.match(req.headers["x-openbot-delivery-id"], /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/);

  const manualSig =
    "sha256=" +
    createHmac("sha256", dummyWebhookSecret)
      .update(`${req.headers["x-openbot-timestamp"]}.${req.headers["x-openbot-delivery-id"]}.${req.rawBody}`, "utf8")
      .digest("hex");
  assert.equal(req.headers["x-openbot-signature"], manualSig);

  const decoded = JSON.parse(req.rawBody);
  assert.deepEqual(decoded, {
    type: "qa.job.dispatch",
    occurredAt: "2026-11-26T04:15:09.750Z",
    data: {
      schemaVersion: 1,
      jobId: job.jobId,
      executionId: job.executionId,
      targetUrl: job.targetUrl,
      scope: job.scope,
      acceptanceCriteria: job.acceptanceCriteria,
      deliverables: ["summary", "checks", "findings"],
      callback: {
        url: `${appOrigin}/api/v1/callbacks/qa`,
        token: callbackToken,
      },
    },
  });
});

test("Service.dispatch maps OpenBot HTTP 202/200 to accepted, 400/401/404/413 to rejected, and 503/429/network to unknown+503", async () => {
  const cfg = readWebhookConfig({ QA_WEBHOOK_URL: dummyWebhookUrl, QA_WEBHOOK_SECRET: dummyWebhookSecret });
  const baseJob = makeDummyJob();

  async function runWithStatus(statusOrError: number | Error) {
    const calls: Array<{ outcome: string; code?: string | null; tokenHash?: string }> = [];
    const store: JobWebhookStore = {
      async job() { return baseJob; },
      async claimWebhook(_id, tokenHash) {
        calls.push({ outcome: "claim", tokenHash });
        return { job: { ...baseJob, deliveryStatus: "sending", version: 2 }, attemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", requiresReconciliation: false };
      },
      async webhookOutcome(_id, _attemptId, outcome, errorCode, errorMessage) {
        calls.push({ outcome, code: errorCode });
        return {
          applied: true,
          job: {
            ...baseJob,
            version: 3,
            deliveryStatus: outcome === "rejected" ? "failed" : outcome,
            executionStatus: outcome === "accepted" ? "running" : "not_started",
            lastError: errorCode && errorMessage ? { code: errorCode, message: errorMessage } : null,
          },
        };
      },
    };
    const dispatcher = new WebhookDispatcher(appOrigin, cfg, async () => {
      if (statusOrError instanceof Error) throw statusOrError;
      return new Response("{}", { status: statusOrError });
    });
    const service = new Service(store, dispatcher);
    return { service, calls };
  }

  for (const okStatus of [202, 200]) {
    const { service, calls } = await runWithStatus(okStatus);
    const result = await service.dispatch(baseJob.jobId, "dispatch");
    assert.equal(result.deliveryStatus, "accepted");
    assert.equal(result.executionStatus, "running");
    assert.equal(calls[0]?.tokenHash?.length, 64);
    assert.equal(calls[1]?.outcome, "accepted");
  }

  for (const rejectStatus of [400, 401, 404, 413]) {
    const { service, calls } = await runWithStatus(rejectStatus);
    const result = await service.dispatch(baseJob.jobId, "dispatch");
    assert.equal(result.deliveryStatus, "failed");
    assert.equal(result.lastError?.code, "WEBHOOK_REJECTED");
    assert.equal(calls[1]?.outcome, "rejected");
  }

  for (const ambiguous of [503, 429, 500, new Error("network timeout")]) {
    const { service, calls } = await runWithStatus(ambiguous);
    await assert.rejects(
      service.dispatch(baseJob.jobId, "dispatch"),
      (err: unknown) => err instanceof Fault && err.status === 503 && err.code === "RECONCILIATION_REQUIRED",
    );
    assert.equal(calls[1]?.outcome, "unknown");
    assert.equal(calls[1]?.code, "DELIVERY_UNKNOWN");
  }
});

test("callbackSchema and verifyAuthenticatedCallback enforce HMAC, replay window, and agent/simulation payloads", () => {
  const cfg = readWebhookConfig({ QA_WEBHOOK_URL: dummyWebhookUrl, QA_WEBHOOK_SECRET: dummyWebhookSecret, QA_CALLBACK_SECRET: dummyCallbackSecret });
  const job = makeDummyJob();
  const callbackToken = deriveCallbackToken(cfg.callbackKeyMaterial, job.jobId, job.executionId);
  const nowMs = Date.parse("2026-11-26T04:20:00.000Z");
  const ts = String(Math.floor(nowMs / 1000));

  const succeededPayload = {
    schemaVersion: 1 as const,
    mode: "agent" as const,
    eventId: randomUUID(),
    jobId: job.jobId,
    executionId: job.executionId,
    sequence: 2 as const,
    eventType: "succeeded" as const,
    result: {
      summary: "Pemeriksaan selesai oleh Jess.",
      checks: [
        { criterionIndex: 0, outcome: "pass" as const, note: "Judul utama tampil." },
        { criterionIndex: 1, outcome: "fail" as const, note: "Pesan kosong belum tampil." },
      ],
      findings: [
        {
          title: "Validasi form kosong absen",
          steps: "Buka halaman lalu tekan submit tanpa isi",
          expected: "Pesan error tampil",
          actual: "Form terkirim tanpa pesan",
        },
      ],
    },
    error: null,
  };
  assert.equal(callbackSchema.safeParse(succeededPayload).success, true);

  const rawText = JSON.stringify(succeededPayload);
  const rawBytes = Buffer.from(rawText, "utf8");
  const validSig = signCallbackPayload(callbackToken, ts, rawBytes);

  const verified = verifyAuthenticatedCallback({
    webhookConfig: cfg,
    timestampHeader: ts,
    signatureHeader: validSig,
    rawBody: rawBytes,
    parsedJson: succeededPayload,
    nowMs,
  });
  assert.equal(verified.callbackToken, callbackToken);
  assert.equal(verified.event.mode, "agent");
  assert.equal(verified.event.sequence, 2);

  // Boundary +/- 300s passes; 301s fails with 401 UNAUTHORIZED_CALLBACK
  verifyAuthenticatedCallback({
    webhookConfig: cfg,
    timestampHeader: ts,
    signatureHeader: validSig,
    rawBody: rawBytes,
    parsedJson: succeededPayload,
    nowMs: nowMs + 300_000,
  });
  failsWith(
    () =>
      verifyAuthenticatedCallback({
        webhookConfig: cfg,
        timestampHeader: ts,
        signatureHeader: validSig,
        rawBody: rawBytes,
        parsedJson: succeededPayload,
        nowMs: nowMs + 301_000,
      }),
    401,
    "UNAUTHORIZED_CALLBACK",
  );

  // Tampered raw body (whitespace difference with identical parsedJson) must fail HMAC check
  failsWith(
    () =>
      verifyAuthenticatedCallback({
        webhookConfig: cfg,
        timestampHeader: ts,
        signatureHeader: validSig,
        rawBody: Buffer.from(rawText + " ", "utf8"),
        parsedJson: succeededPayload,
        nowMs,
      }),
    401,
    "UNAUTHORIZED_CALLBACK",
  );

  // Wrong token or malformed headers fail with 401 UNAUTHORIZED_CALLBACK
  failsWith(
    () =>
      verifyAuthenticatedCallback({
        webhookConfig: cfg,
        timestampHeader: ts,
        signatureHeader: signCallbackPayload("0".repeat(64), ts, rawBytes),
        rawBody: rawBytes,
        parsedJson: succeededPayload,
        nowMs,
      }),
    401,
    "UNAUTHORIZED_CALLBACK",
  );
  failsWith(
    () =>
      verifyAuthenticatedCallback({
        webhookConfig: cfg,
        timestampHeader: "not-a-number",
        signatureHeader: validSig,
        rawBody: rawBytes,
        parsedJson: succeededPayload,
        nowMs,
      }),
    401,
    "UNAUTHORIZED_CALLBACK",
  );

  // PT401 UNAUTHORIZED_CALLBACK from database maps to HTTP 401
  const dbFault = databaseFault({ code: "PT401", message: "UNAUTHORIZED_CALLBACK" });
  assert.equal(dbFault.status, 401);
  assert.equal(dbFault.code, "UNAUTHORIZED_CALLBACK");
});

test("handleRequest callback routes: /callbacks/simulator stays 503 CALLBACK_DISABLED; /callbacks/qa allows machine POST without Origin", async () => {
  const prevEnv = {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    QA_APP_ORIGIN: process.env.QA_APP_ORIGIN,
    QA_WEBHOOK_URL: process.env.QA_WEBHOOK_URL,
    QA_WEBHOOK_SECRET: process.env.QA_WEBHOOK_SECRET,
    QA_CALLBACK_SECRET: process.env.QA_CALLBACK_SECRET,
  };
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_dummy_test_only";
  process.env.QA_APP_ORIGIN = appOrigin;
  delete process.env.QA_WEBHOOK_URL;
  delete process.env.QA_WEBHOOK_SECRET;
  delete process.env.QA_CALLBACK_SECRET;

  try {
    const simRes = await handleRequest(
      new Request("http://internal:3000/api/v1/callbacks/simulator", {
        method: "POST",
        headers: { Host: "qa.example.invalid", "Content-Type": "application/json" },
        body: "{}",
      }),
    );
    assert.equal(simRes.status, 503);
    assert.equal((await simRes.json()).error.code, "CALLBACK_DISABLED");

    // Unconfigured webhook env on /callbacks/qa returns 503 WEBHOOK_UNCONFIGURED without requiring Origin
    const unconfRes = await handleRequest(
      new Request("http://internal:3000/api/v1/callbacks/qa", {
        method: "POST",
        headers: { Host: "qa.example.invalid", "Content-Type": "application/json" },
        body: "{}",
      }),
    );
    assert.equal(unconfRes.status, 503);
    assert.equal((await unconfRes.json()).error.code, "WEBHOOK_UNCONFIGURED");
    assert.equal(unconfRes.headers.get("set-cookie"), null);

    process.env.QA_WEBHOOK_URL = dummyWebhookUrl;
    process.env.QA_WEBHOOK_SECRET = dummyWebhookSecret;

    // Host mismatch rejected
    const badHostRes = await handleRequest(
      new Request("http://internal:3000/api/v1/callbacks/qa", {
        method: "POST",
        headers: { Host: "attacker.invalid", "Content-Type": "application/json" },
        body: "{}",
      }),
    );
    assert.equal(badHostRes.status, 403);
    assert.equal((await badHostRes.json()).error.code, "HOST_NOT_ALLOWED");

    // Query string rejected
    const queryRes = await handleRequest(
      new Request("http://internal:3000/api/v1/callbacks/qa?extra=1", {
        method: "POST",
        headers: { Host: "qa.example.invalid", "Content-Type": "application/json" },
        body: "{}",
      }),
    );
    assert.equal(queryRes.status, 400);
    assert.equal((await queryRes.json()).error.code, "INVALID_REQUEST");

    // Missing/invalid HMAC rejected with 401 UNAUTHORIZED_CALLBACK (no Origin header required, no DB hit)
    const unauthRes = await handleRequest(
      new Request("http://internal:3000/api/v1/callbacks/qa", {
        method: "POST",
        headers: { Host: "qa.example.invalid", "Content-Type": "application/json" },
        body: "{}",
      }),
    );
    assert.equal(unauthRes.status, 401);
    assert.equal((await unauthRes.json()).error.code, "UNAUTHORIZED_CALLBACK");
    assert.equal(unauthRes.headers.get("set-cookie"), null);
  } finally {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
