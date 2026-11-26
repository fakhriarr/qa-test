import "./only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Callback, CallbackResponse, CreateJob, Job } from "../contracts";
import { Fault } from "./errors";
import { databaseFault } from "./database-errors";

type JobRow = { input: CreateJob; job_id: string; execution_id: string; created_at: string; updated_at: string; version: number;
  delivery_status: Job["deliveryStatus"]; execution_status: Job["executionStatus"]; last_error: Job["lastError"]; result: Job["result"]; lease_expires_at: string | null };
export type Claim = { job: Job; attemptId: string; requiresReconciliation: boolean };
export type Lookup = { kind: "not_found" } | { kind: "accepted" | "terminal"; executionId: string };
function dto(row: JobRow): Job {
  return { ...row.input, mode: "simulation", jobId: row.job_id, executionId: row.execution_id, createdAt: row.created_at,
    updatedAt: row.updated_at, version: row.version, deliveryStatus: row.delivery_status, executionStatus: row.execution_status,
    lastError: row.last_error, result: row.result, leaseExpiresAt: row.lease_expires_at };
}
const columns = "input,job_id,execution_id,created_at,updated_at,version,delivery_status,execution_status,last_error,result,lease_expires_at";
export class Store {
  constructor(readonly client: SupabaseClient) {}
  private async rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.client.rpc(name, args);
    if (error) throw databaseFault(error);
    return data as T;
  }
  async list(): Promise<Job[]> {
    const { data, error } = await this.client.from("qa_jobs").select(columns).order("created_at", { ascending: false }).order("job_id", { ascending: false }).limit(100);
    if (error) throw databaseFault(error);
    return (data as JobRow[]).map(dto);
  }
  async job(id: string): Promise<Job> {
    const { data, error } = await this.client.from("qa_jobs").select(columns).eq("job_id", id).maybeSingle();
    if (error) throw databaseFault(error);
    if (!data) throw new Fault(404, "JOB_NOT_FOUND", "Job tidak ditemukan.");
    return dto(data as JobRow);
  }
  create(input: CreateJob, key: string) { return this.rpc<{job: Job; replay: boolean}>("qa_create_job", { p_key: key, p_input: input }); }
  claim(id: string, action: "dispatch" | "retry" | "reconcile") {
    return this.rpc<Claim>("qa_claim_dispatch", { p_job_id: id, p_retry: action === "retry", p_reconcile: action === "reconcile" });
  }
  claimWebhook(id: string, callbackTokenHash: string, action: "dispatch" | "retry" | "reconcile") {
    return this.rpc<Claim>("qa_claim_webhook_dispatch", {
      p_job_id: id, p_callback_token_hash: callbackTokenHash, p_retry: action === "retry", p_reconcile: action === "reconcile",
    });
  }
  outcome(id: string, attemptId: string, outcome: "accepted" | "rejected" | "unknown") {
    return this.rpc<{job: Job; applied: boolean}>("qa_record_outcome", { p_job_id: id, p_attempt_id: attemptId, p_outcome: outcome });
  }
  webhookOutcome(
    id: string,
    attemptId: string,
    outcome: "accepted" | "rejected" | "unknown",
    errorCode: string | null = null,
    errorMessage: string | null = null,
  ) {
    return this.rpc<{job: Job; applied: boolean}>("qa_record_webhook_outcome", {
      p_job_id: id, p_attempt_id: attemptId, p_outcome: outcome, p_error_code: errorCode, p_error_message: errorMessage,
    });
  }
  agentCallback(callbackToken: string, event: Callback) {
    return this.rpc<CallbackResponse>("qa_apply_agent_callback", { p_callback_token: callbackToken, p_event: event });
  }
  accept(job: Job) { return this.rpc<{kind: "accepted"; executionId: string}>("qa_sim_accept", { p_job_id: job.jobId, p_execution_id: job.executionId }); }
  complete(executionId: string) { return this.rpc<void>("qa_sim_complete", { p_execution_id: executionId }); }
  callback(event: Callback) { return this.rpc<CallbackResponse>("qa_apply_sim_callback", { p_event: event }); }
  markDelivered(eventId: string) { return this.rpc<void>("qa_mark_outbox_delivered", { p_event_id: eventId }); }
  async lookup(executionId: string): Promise<Lookup> {
    const { data, error } = await this.client.from("qa_simulator_inbox").select("state").eq("execution_id", executionId).maybeSingle();
    if (error) throw databaseFault(error);
    return data ? { kind: data.state === "terminal" ? "terminal" : "accepted", executionId } : { kind: "not_found" };
  }
  async pending(executionId: string): Promise<Callback[]> {
    const { data, error } = await this.client.from("qa_simulator_outbox").select("body").eq("execution_id", executionId).eq("delivered", false).order("sequence", { ascending: true });
    if (error) throw databaseFault(error);
    return data.map(row => row.body as Callback);
  }
}
