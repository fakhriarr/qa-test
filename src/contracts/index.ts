import { z } from "zod";

export const SIMULATION_LABEL = "SIMULASI AGENT — bukan integrasi QA OpenBot; penyimpanan Supabase";
export const API_ROOT = "/api/v1";
export const deliverables = ["summary", "checks", "findings"] as const;
export const uuidSchema = z.uuidv4();
const text = (max: number) => z.string().min(1).max(max).refine(v => v.trim().length > 0);
export const safeErrorSchema = z.strictObject({ code: text(100), message: text(1000) });
export const createJobSchema = z.strictObject({
  schemaVersion: z.literal(1),
  targetUrl: z.string().min(1).max(2048).refine(v => {
    try { const u = new URL(v); return /^https?:\/\/(?:\[[0-9a-fA-F:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)(?::[0-9]{1,5})?(?:[/?#][^\s]*)?$/.test(v) && !/\s/.test(v) && !!u.hostname && !u.username && !u.password; }
    catch { return false; }
  }),
  scope: text(2000),
  acceptanceCriteria: z.array(text(500)).min(1).max(10),
  deliverables: z.array(z.enum(deliverables)).length(3).refine(v => new Set(v).size === 3),
});
export const resultSchema = z.strictObject({
  summary: text(2000),
  checks: z.array(z.strictObject({ criterionIndex: z.number().int().min(0).max(9), outcome: z.enum(["pass", "fail", "blocked"]), note: z.string().max(1000) })).min(1).max(10),
  findings: z.array(z.strictObject({ title: text(200), steps: text(2000), expected: text(1000), actual: text(1000) })).max(20),
});
export const deliveryStatuses = ["not_sent", "sending", "accepted", "failed", "unknown"] as const;
export const executionStatuses = ["not_started", "running", "succeeded", "failed"] as const;
export type CreateJob = z.infer<typeof createJobSchema>;
export type Result = z.infer<typeof resultSchema>;
export type SafeError = z.infer<typeof safeErrorSchema>;
export type Job = CreateJob & {
  jobId: string; executionId: string; mode: "simulation";
  createdAt: string; updatedAt: string; version: number;
  deliveryStatus: typeof deliveryStatuses[number]; executionStatus: typeof executionStatuses[number];
  lastError: SafeError | null; result: Result | null; leaseExpiresAt: string | null;
};
export type ExecutionEnvelope = CreateJob & { mode: "simulation"; jobId: string; executionId: string };
export const callbackSchema = z.strictObject({
  schemaVersion: z.literal(1), mode: z.enum(["agent", "simulation"]), eventId: uuidSchema,
  jobId: uuidSchema, executionId: uuidSchema, sequence: z.union([z.literal(1), z.literal(2)]),
  eventType: z.enum(["running", "succeeded", "failed"]), result: resultSchema.nullable(), error: safeErrorSchema.nullable(),
}).superRefine((v, c) => {
  const valid = v.eventType === "running" ? v.sequence === 1 && v.result === null && v.error === null
    : v.sequence === 2 && (v.eventType === "succeeded" ? v.result !== null && v.error === null : v.result === null && v.error !== null);
  if (!valid) c.addIssue({ code: "custom", message: "Invalid event sequence or terminal payload" });
});
export type Callback = z.infer<typeof callbackSchema>;
export type CallbackResponse = { accepted: true; duplicate: boolean; applied: boolean };
export type JobResponse = { job: Job };
export type JobListResponse = { mode: "simulation"; jobs: Job[] };
export type ApiError = { error: SafeError & { requestId: string } };

export const loginSchema = z.strictObject({ email: z.email().max(254), password: z.string().min(1).max(1024) });
export const passwordSchema = z.strictObject({ password: z.string().min(12).max(1024) });
export type SessionUser = { id: string; email: string | null };
export type SessionResponse = { user: SessionUser; mode: "simulation"; storage: "supabase" };
export function isTerminal(job: Job) { return job.executionStatus === "succeeded" || job.executionStatus === "failed"; }
export function canReconcile(job: Job, now = Date.now()): boolean {
  if (job.leaseExpiresAt !== null && Date.parse(job.leaseExpiresAt) > now) return false;
  return !isTerminal(job) && (job.deliveryStatus === "unknown" || job.deliveryStatus === "accepted" ||
    (job.deliveryStatus === "sending" && job.leaseExpiresAt !== null && Date.parse(job.leaseExpiresAt) <= now));
}
