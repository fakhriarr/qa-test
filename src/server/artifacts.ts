import "./only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Job } from "../contracts";
import { ARTIFACT_MAX_BYTES, type Deliverable, type DeliverableKind } from "../contracts/requests";
import { boundedBytes } from "./boundary";
import { validArtifact } from "./artifact-format";
import { createPublicClient } from "./auth";
import { readWebhookConfig, type AppConfig } from "./config";
import { databaseFault } from "./database-errors";
import { assert, Fault } from "./errors";
import { deriveCallbackToken } from "./webhook";

const bucket = "qa-deliverables";
export const MULTIPART_MAX_BYTES = ARTIFACT_MAX_BYTES + 16_384;
type ArtifactRow = {
  owner_id: string; job_id: string; execution_id: string; deliverable_id: string; kind: DeliverableKind;
  file_name: string | null; size_bytes: number | null; sha256: string | null; ready_at: string | null;
};
const columns = "owner_id,job_id,execution_id,deliverable_id,kind,file_name,size_bytes,sha256,ready_at";

export function artifactPath(jobId: string, executionId: string, itemId: string) {
  return `/api/v1/callbacks/qa/${jobId}/executions/${executionId}/deliverables/${itemId}`;
}

export function artifactToken(callbackToken: string, itemId: string) {
  return createHmac("sha256", callbackToken).update("qa-artifact:v1:" + itemId).digest("hex");
}

const checksum = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export function storageCapability(key: Uint8Array, job: string, execution: string, item: string) {
  return createHmac("sha256", key).update(`qa-storage:v1:${job}:${execution}:${item}`).digest("hex");
}

export async function bindArtifactUploads(client: SupabaseClient, job: Job, items: ArtifactRow[], key: Uint8Array) {
  const hashes = Object.fromEntries(items.map(({ deliverable_id: id }) =>
    [id, checksum(Buffer.from(storageCapability(key, job.jobId, job.executionId, id)))]));
  const { error } = await client.rpc("qa_bind_artifact_uploads", {
    p_job: job.jobId, p_execution: job.executionId, p_hashes: hashes,
  });
  if (error) throw databaseFault(error);
}

const storagePath = (row: ArtifactRow) => `${row.owner_id}/${row.job_id}/${row.execution_id}/${row.deliverable_id}`;

export async function jobArtifacts(client: SupabaseClient, job: Job): Promise<ArtifactRow[]> {
  const { data, error } = await client.from("qa_artifacts").select(columns)
    .eq("job_id", job.jobId).eq("execution_id", job.executionId).order("kind");
  if (error) throw databaseFault(error);
  return data;
}

function dto(row: ArtifactRow, terminal: boolean): Deliverable {
  const ready = Boolean(row.ready_at);
  return {
    deliverableId: row.deliverable_id, kind: row.kind, status: ready ? "ready" : terminal ? "failed" : "pending",
    fileName: ready ? row.file_name : null, sizeBytes: ready ? row.size_bytes : null,
    sha256: ready ? row.sha256 : null, readyAt: row.ready_at,
    downloadUrl: ready ? `/api/v1/jobs/${row.job_id}/deliverables/${row.deliverable_id}` : null,
  };
}

export async function deliverableProgress(client: SupabaseClient, job: Job) {
  const terminal = job.executionStatus === "succeeded" || job.executionStatus === "failed";
  const items = (await jobArtifacts(client, job)).map(row => dto(row, terminal));
  const ready = items.filter(item => item.status === "ready").length;
  return { items, ready, total: items.length, partial: terminal && ready > 0 && ready < items.length };
}

export async function uploadArtifact(request: Request, config: AppConfig, job: string, execution: string, item: string) {
  const key = readWebhookConfig().callbackKeyMaterial;
  const token = deriveCallbackToken(key, job, execution);
  const expected = artifactToken(token, item);
  const supplied = request.headers.get("authorization")?.match(/^Bearer ([0-9a-f]{64})$/)?.[1];
  assert(supplied && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected)), 401,
    "UNAUTHORIZED_CALLBACK", "Autentikasi unggahan tidak valid.");

  const client = createPublicClient(config, { "x-qa-storage-capability": storageCapability(key, job, execution, item) });
  const identity = { p_job: job, p_execution: execution, p_item: item };
  const lookup = await client.rpc("qa_artifact_upload_item", identity).single<ArtifactRow>();
  if (lookup.error) throw databaseFault(lookup.error);
  const contentType = request.headers.get("content-type");
  assert(contentType && /^multipart\/form-data\s*;/i.test(contentType), 415, "MULTIPART_REQUIRED", "Gunakan multipart/form-data.");
  const raw = await boundedBytes(request, MULTIPART_MAX_BYTES);
  const form = await new Response(new Uint8Array(raw), { headers: { "Content-Type": contentType } }).formData()
    .catch(() => { throw new Fault(400, "INVALID_MULTIPART", "Form multipart tidak valid."); });
  const file = form.get("file");
  const sha = form.get("sha256");
  assert([...form.keys()].length === 2 && file instanceof File && typeof sha === "string" && /^[0-9a-f]{64}$/.test(sha),
    400, "INVALID_MULTIPART", "Kirim satu file dan satu SHA-256 lowercase.");
  assert(file.size <= ARTIFACT_MAX_BYTES, 413, "BODY_TOO_LARGE", "File melebihi 3 MiB.");
  assert(file.size > 0, 400, "INVALID_ARTIFACT", "File kosong.");
  const bytes = Buffer.from(await file.arrayBuffer());
  assert(checksum(bytes) === sha, 400, "CHECKSUM_MISMATCH", "Checksum file tidak cocok.");
  assert(validArtifact(lookup.data.kind, file.name, bytes), 415, "INVALID_ARTIFACT_FORMAT", "Format file tidak sesuai jenis deliverable.");

  const reserved = await client.rpc("qa_reserve_artifact", {
    ...identity,
    p_name: file.name, p_size: bytes.length, p_sha: sha,
  }).single<ArtifactRow>();
  if (reserved.error) throw databaseFault(reserved.error);
  const row = reserved.data;
  if (row.ready_at) return { deliverable: dto(row, false), replay: true };

  const storage = client.storage.from(bucket);
  const path = storagePath(row);
  const { error: uploadError } = await storage.upload(path, new Uint8Array(bytes), {
    contentType: "application/octet-stream", upsert: false,
  });
  if (uploadError) {
    // The previous attempt may have persisted the object before timing out.
    const { data } = await storage.download(path);
    assert(data && data.size === bytes.length && checksum(Buffer.from(await data.arrayBuffer())) === sha,
      503, "ARTIFACT_STORAGE_UNAVAILABLE", "File belum siap. Coba ulang dengan file yang sama.");
  }

  const finished = await client.rpc("qa_finish_artifact", {
    ...identity, p_sha: sha,
  }).single<ArtifactRow>();
  if (finished.error) throw databaseFault(finished.error);
  return { deliverable: dto(finished.data, false), replay: Boolean(uploadError) };
}

export async function downloadArtifact(client: SupabaseClient, jobId: string, itemId: string) {
  const { data, error } = await client.from("qa_artifacts").select(columns)
    .eq("job_id", jobId).eq("deliverable_id", itemId).not("ready_at", "is", null).maybeSingle<ArtifactRow>();
  if (error) throw databaseFault(error);
  assert(data, 404, "ARTIFACT_NOT_FOUND", "File tidak ditemukan.");
  const result = await client.storage.from(bucket).download(storagePath(data));
  assert(result.data && !result.error, 503, "ARTIFACT_STORAGE_UNAVAILABLE", "File belum dapat diunduh. Coba lagi.");
  const bytes = Buffer.from(await result.data.arrayBuffer());
  assert(data.file_name && data.size_bytes === bytes.length && data.sha256 === checksum(bytes) &&
    validArtifact(data.kind, data.file_name, bytes), 503, "ARTIFACT_STORAGE_UNAVAILABLE", "Integritas file tidak dapat dikonfirmasi.");
  return new Response(result.data, { headers: {
    "Cache-Control": "private, no-store",
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename="${data.file_name}"`,
    "X-Content-Type-Options": "nosniff",
  } });
}
