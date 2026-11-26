import "./only";
import type { Job } from "../contracts";
import type { Claim } from "./store";
import { Fault, assert } from "./errors";
import { WebhookDispatcher, deriveCallbackToken, hashCallbackToken, type DispatchRequestDetails } from "./webhook";

export interface JobWebhookStore {
  job(id: string): Promise<Job>;
  claimWebhook(id: string, callbackTokenHash: string, action: "dispatch" | "retry" | "reconcile"): Promise<Claim>;
  webhookOutcome(
    id: string,
    attemptId: string,
    outcome: "accepted" | "rejected" | "unknown",
    errorCode?: string | null,
    errorMessage?: string | null,
  ): Promise<{ job: Job; applied: boolean }>;
}

export class Service {
  constructor(readonly store: JobWebhookStore, readonly dispatcher: WebhookDispatcher) {}

  async dispatch(id: string, action: "dispatch" | "retry" | "reconcile",
    details?: (job: Job, callbackToken: string) => Promise<DispatchRequestDetails | undefined>,
  ): Promise<Job> {
    const current = await this.store.job(id);
    const callbackToken = deriveCallbackToken(this.dispatcher.config.callbackKeyMaterial, current.jobId, current.executionId);
    const requestDetails = await details?.(current, callbackToken);
    const callbackTokenHash = hashCallbackToken(callbackToken);
    const claim = await this.store.claimWebhook(id, callbackTokenHash, action);
    assert(claim.job.executionId === current.executionId, 409, "EXECUTION_MISMATCH", "Identitas eksekusi job berubah.");

    const recordSafely = async (
      outcome: "accepted" | "rejected" | "unknown",
      code?: string | null,
      message?: string | null,
    ) => {
      try {
        return await this.store.webhookOutcome(id, claim.attemptId, outcome, code ?? null, message ?? null);
      } catch (error) {
        if (error instanceof Fault && [401, 403].includes(error.status)) throw error;
        throw new Fault(503, "RECONCILIATION_REQUIRED", "Koneksi data terputus. Muat ulang; rekonsiliasi setelah lease berakhir.");
      }
    };

    const sendResult = await this.dispatcher.send(claim.job, callbackToken, requestDetails);
    if (sendResult.outcome === "accepted") {
      return (await recordSafely("accepted")).job;
    }
    if (sendResult.outcome === "rejected") {
      return (await recordSafely("rejected", sendResult.code, sendResult.message)).job;
    }
    // Ambiguous 5xx/429/network/timeout: never infer rejection or replace execution identity.
    await recordSafely("unknown", "DELIVERY_UNKNOWN", "Outcome pengiriman webhook belum diketahui; lakukan rekonsiliasi.");
    throw new Fault(503, "RECONCILIATION_REQUIRED", "Outcome belum pasti. Muat ulang status lalu lakukan rekonsiliasi.");
  }
}
