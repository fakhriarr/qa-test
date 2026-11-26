import "./only";
import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { callbackSchema, type Callback, type Job } from "../contracts";
import type { DeliverableKind, ValidatedSubmission } from "../contracts/requests";
import type { WebhookConfig } from "./config";
import { parse } from "./boundary";
import { Fault } from "./errors";

export const WEBHOOK_MAX_BODY_BYTES = 65536;
export const WEBHOOK_TIMEOUT_MS = 15_000;
export const CALLBACK_MAX_SKEW_SECONDS = 300;

export function deriveCallbackToken(callbackKeyMaterial: Uint8Array, jobId: string, executionId: string): string {
  return Buffer.from(
    new Uint8Array(hkdfSync("sha256", callbackKeyMaterial, jobId, "qa-dashboard:callback-token:v1:" + executionId, 32)),
  ).toString("hex");
}

export function hashCallbackToken(callbackToken: string): string {
  return createHash("sha256").update(callbackToken, "utf8").digest("hex");
}

export function signOpenBotWebhook(secret: string, timestamp: string, deliveryId: string, rawBody: Uint8Array): string {
  return "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${deliveryId}.`, "utf8").update(rawBody).digest("hex");
}

export function signCallbackPayload(callbackToken: string, timestamp: string, rawBody: Uint8Array): string {
  return "sha256=" + createHmac("sha256", callbackToken).update(`${timestamp}.`, "utf8").update(rawBody).digest("hex");
}

export type DispatchRequestDetails = Omit<ValidatedSubmission, "deliverables" | "acceptanceCriteria" | "targetUrl"> & {
  deliverables: { deliverableId: string; kind: DeliverableKind; uploadUrl: string; uploadToken: string }[];
  securityPolicy: "defensive_only";
};

export function buildOpenBotDispatchRequest(params: {
  appOrigin: string;
  webhookConfig: WebhookConfig;
  job: Job;
  callbackToken: string;
  nowMs?: number;
  requestDetails?: DispatchRequestDetails;
}) {
  const nowMs = params.nowMs ?? Date.now();
  const timestamp = String(Math.floor(nowMs / 1000));
  const deliveryId = `qa-exec:${params.job.executionId}`;
  const payload = {
    type: "qa.job.dispatch" as const,
    occurredAt: new Date(nowMs).toISOString(),
    data: {
      schemaVersion: 1 as const,
      jobId: params.job.jobId,
      executionId: params.job.executionId,
      targetUrl: params.job.targetUrl,
      scope: params.job.scope,
      acceptanceCriteria: params.job.acceptanceCriteria,
      deliverables: ["summary", "checks", "findings"] as const,
      ...(params.requestDetails ? { request: params.requestDetails } : {}),
      callback: {
        url: `${params.appOrigin}/api/v1/callbacks/qa`,
        token: params.callbackToken,
      },
    },
  };
  const rawBody = JSON.stringify(payload);
  const bodyBytes = Buffer.from(rawBody, "utf8");
  const signature = signOpenBotWebhook(params.webhookConfig.webhookSecret, timestamp, deliveryId, bodyBytes);
  return {
    url: params.webhookConfig.webhookUrl,
    rawBody,
    bodyBytes,
    payload,
    headers: {
      "Content-Type": "application/json",
      "x-openbot-timestamp": timestamp,
      "x-openbot-delivery-id": deliveryId,
      "x-openbot-signature": signature,
    },
  };
}

export function verifyAuthenticatedCallback(params: {
  webhookConfig: WebhookConfig;
  timestampHeader: string | null;
  signatureHeader: string | null;
  rawBody: Uint8Array;
  parsedJson: unknown;
  nowMs?: number;
}): { event: Callback; callbackToken: string } {
  const unauth = () => new Fault(401, "UNAUTHORIZED_CALLBACK", "Autentikasi callback tidak valid atau kedaluwarsa.");
  const { timestampHeader, signatureHeader, rawBody, parsedJson } = params;
  if (!timestampHeader || !/^(?:0|[1-9][0-9]{0,12})$/.test(timestampHeader)) throw unauth();
  if (!signatureHeader || !/^sha256=[0-9a-f]{64}$/.test(signatureHeader)) throw unauth();
  const timestampSec = Number(timestampHeader);
  const nowSec = Math.floor((params.nowMs ?? Date.now()) / 1000);
  if (!Number.isSafeInteger(timestampSec) || Math.abs(nowSec - timestampSec) > CALLBACK_MAX_SKEW_SECONDS) {
    throw unauth();
  }
  const event = parse(callbackSchema, parsedJson);
  const callbackToken = deriveCallbackToken(params.webhookConfig.callbackKeyMaterial, event.jobId, event.executionId);
  const expectedSignature = signCallbackPayload(callbackToken, timestampHeader, rawBody);
  const actualBuf = Buffer.from(signatureHeader, "utf8");
  const expectedBuf = Buffer.from(expectedSignature, "utf8");
  if (actualBuf.byteLength !== expectedBuf.byteLength || !timingSafeEqual(actualBuf, expectedBuf)) {
    throw unauth();
  }
  return { event, callbackToken };
}

export type WebhookSendOutcome =
  | { outcome: "accepted"; status: 200 | 202 }
  | { outcome: "rejected"; status: 400 | 401 | 404 | 413; code: string; message: string }
  | { outcome: "unknown" };

const REJECTED_MESSAGES: Record<400 | 401 | 404 | 413, string> = {
  400: "Permintaan ditolak webhook QA (400 payload tidak valid). Periksa kontrak lalu coba Retry.",
  401: "Autentikasi webhook QA ditolak (401 secret atau jam tidak cocok). Periksa QA_WEBHOOK_SECRET lalu coba Retry.",
  404: "Webhook routine QA tidak ditemukan (404). Periksa QA_WEBHOOK_URL lalu coba Retry.",
  413: "Ukuran payload job melebihi batas webhook QA (413).",
};

export class WebhookDispatcher {
  constructor(
    readonly appOrigin: string,
    readonly config: WebhookConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async send(job: Job, callbackToken: string, requestDetails?: DispatchRequestDetails): Promise<WebhookSendOutcome> {
    const req = buildOpenBotDispatchRequest({
      appOrigin: this.appOrigin,
      webhookConfig: this.config,
      job,
      callbackToken,
      nowMs: this.now(),
      requestDetails,
    });
    if (req.bodyBytes.byteLength > WEBHOOK_MAX_BODY_BYTES) {
      return {
        outcome: "rejected",
        status: 413,
        code: "WEBHOOK_REJECTED",
        message: REJECTED_MESSAGES[413],
      };
    }
    try {
      const response = await this.fetchImpl(req.url, {
        method: "POST",
        headers: req.headers,
        body: req.rawBody,
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      await response.body?.cancel().catch(() => {});
      if (response.status === 202 || response.status === 200) {
        return { outcome: "accepted", status: response.status };
      }
      if (response.status === 400 || response.status === 401 || response.status === 404 || response.status === 413) {
        return {
          outcome: "rejected",
          status: response.status,
          code: "WEBHOOK_REJECTED",
          message: REJECTED_MESSAGES[response.status],
        };
      }
      return { outcome: "unknown" };
    } catch {
      return { outcome: "unknown" };
    }
  }
}
