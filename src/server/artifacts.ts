import "./only";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Job } from "../contracts";
import {
  ARTIFACT_MAX_BYTES,
  type Deliverable,
  type DeliverableKind,
  type DeliverableVersion,
  type DocumentStatus,
  type RevisionGrant,
} from "../contracts/requests";
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
  active_version_id?: string | null; active_version_number?: number | null; document_status?: DocumentStatus | null;
};
type ArtifactVersionRow = {
  version_id: string; deliverable_id: string; owner_id: string; job_id: string; execution_id: string;
  version_number: number; file_name: string; size_bytes: number; sha256: string;
  document_status: DocumentStatus; revision_note: string; object_name: string; ready_at: string | null;
};
const columns = "owner_id,job_id,execution_id,deliverable_id,kind,file_name,size_bytes,sha256,ready_at,active_version_id,active_version_number,document_status";
const versionColumns = "version_id,deliverable_id,owner_id,job_id,execution_id,version_number,file_name,size_bytes,sha256,document_status,revision_note,object_name,ready_at";

export function artifactPath(jobId: string, executionId: string, itemId: string) {
  return `/api/v1/callbacks/qa/${jobId}/executions/${executionId}/deliverables/${itemId}`;
}

export function artifactRevisionPath(jobId: string, executionId: string, itemId: string) {
  return `/api/v1/callbacks/qa/${jobId}/executions/${executionId}/deliverables/${itemId}/revisions`;
}

export function artifactVersionDownloadPath(jobId: string, itemId: string, versionId: string) {
  return `/api/v1/jobs/${jobId}/deliverables/${itemId}/versions/${versionId}`;
}

export function artifactToken(callbackToken: string, itemId: string) {
  return createHmac("sha256", callbackToken).update("qa-artifact:v1:" + itemId).digest("hex");
}

const checksum = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export function storageCapability(key: Uint8Array, job: string, execution: string, item: string) {
  return createHmac("sha256", key).update(`qa-storage:v1:${job}:${execution}:${item}`).digest("hex");
}

export function revisionStorageCapability(key: Uint8Array, job: string, execution: string, item: string, tokenHash: string) {
  return createHmac("sha256", key).update(`qa-revision-storage:v1:${job}:${execution}:${item}:${tokenHash}`).digest("hex");
}

export async function bindArtifactUploads(client: SupabaseClient, job: Job, items: ArtifactRow[], key: Uint8Array) {
  const hashes = Object.fromEntries(items.map(({ deliverable_id: id }) =>
    [id, checksum(Buffer.from(storageCapability(key, job.jobId, job.executionId, id)))]));
  const { error } = await client.rpc("qa_bind_artifact_uploads", {
    p_job: job.jobId, p_execution: job.executionId, p_hashes: hashes,
  });
  if (error) throw databaseFault(error);
}

const storagePath = (row: Pick<ArtifactRow, "owner_id" | "job_id" | "execution_id" | "deliverable_id">) =>
  `${row.owner_id}/${row.job_id}/${row.execution_id}/${row.deliverable_id}`;

function activeObjectPath(row: ArtifactRow): string {
  if (row.active_version_id && (row.active_version_number ?? 1) > 1) {
    return `${storagePath(row)}/v/${row.active_version_id}`;
  }
  return storagePath(row);
}

export async function jobArtifacts(client: SupabaseClient, job: Job): Promise<ArtifactRow[]> {
  const { data, error } = await client.from("qa_artifacts").select(columns)
    .eq("job_id", job.jobId).eq("execution_id", job.executionId).order("kind");
  if (error) throw databaseFault(error);
  return data;
}

async function jobArtifactVersions(client: SupabaseClient, job: Job): Promise<ArtifactVersionRow[]> {
  const { data, error } = await client.from("qa_artifact_versions").select(versionColumns)
    .eq("job_id", job.jobId).eq("execution_id", job.executionId)
    .not("ready_at", "is", null).order("version_number", { ascending: false });
  if (error) throw databaseFault(error);
  return data ?? [];
}

function versionDto(row: ArtifactVersionRow, activeVersionId: string | null | undefined): DeliverableVersion {
  return {
    versionId: row.version_id,
    versionNumber: row.version_number,
    fileName: row.file_name,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    documentStatus: row.document_status,
    revisionNote: row.revision_note,
    readyAt: row.ready_at ?? "",
    isActive: activeVersionId ? row.version_id === activeVersionId : row.version_number === 1,
    downloadUrl: artifactVersionDownloadPath(row.job_id, row.deliverable_id, row.version_id),
  };
}

function dto(row: ArtifactRow, terminal: boolean, versions: ArtifactVersionRow[] = []): Deliverable {
  const ready = Boolean(row.ready_at);
  const mappedVersions = ready ? versions.map(v => versionDto(v, row.active_version_id)) : [];
  const activeVersionNumber = ready ? (row.active_version_number && row.active_version_number > 0 ? row.active_version_number : 1) : null;
  const documentStatus: DocumentStatus | null = ready ? (row.document_status ?? "draft") : null;
  return {
    deliverableId: row.deliverable_id, kind: row.kind, status: ready ? "ready" : terminal ? "failed" : "pending",
    fileName: ready ? row.file_name : null, sizeBytes: ready ? row.size_bytes : null,
    sha256: ready ? row.sha256 : null, readyAt: row.ready_at,
    downloadUrl: ready ? `/api/v1/jobs/${row.job_id}/deliverables/${row.deliverable_id}` : null,
    documentStatus,
    activeVersionNumber,
    versionCount: ready ? Math.max(mappedVersions.length, 1) : 0,
    versions: mappedVersions,
  };
}

export async function deliverableProgress(client: SupabaseClient, job: Job) {
  const terminal = job.executionStatus === "succeeded" || job.executionStatus === "failed";
  const [rows, versions] = await Promise.all([jobArtifacts(client, job), jobArtifactVersions(client, job)]);
  const byItem = new Map<string, ArtifactVersionRow[]>();
  for (const version of versions) {
    const list = byItem.get(version.deliverable_id) ?? [];
    list.push(version);
    byItem.set(version.deliverable_id, list);
  }
  const items = rows.map(row => dto(row, terminal, byItem.get(row.deliverable_id) ?? []));
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

export async function issueArtifactRevisionGrant(
  client: SupabaseClient, config: AppConfig, jobId: string, itemId: string, ttlMinutes = 1440,
): Promise<{ grant: RevisionGrant }> {
  const { data: item, error: lookupError } = await client.from("qa_artifacts")
    .select("execution_id,kind,ready_at")
    .eq("job_id", jobId).eq("deliverable_id", itemId)
    .maybeSingle<{ execution_id: string; kind: DeliverableKind; ready_at: string | null }>();
  if (lookupError) throw databaseFault(lookupError);
  assert(item, 404, "ARTIFACT_NOT_FOUND", "Deliverable tidak ditemukan.");
  assert(item.ready_at, 409, "ARTIFACT_NOT_READY", "Deliverable belum memiliki file awal yang siap direvisi.");

  const key = readWebhookConfig().callbackKeyMaterial;
  const uploadToken = randomBytes(32).toString("hex");
  const tokenHash = checksum(Buffer.from(uploadToken, "utf8"));
  const storageCap = revisionStorageCapability(key, jobId, item.execution_id, itemId, tokenHash);
  const storageCapHash = checksum(Buffer.from(storageCap, "utf8"));

  const { data, error } = await client.rpc("qa_issue_artifact_revision_grant", {
    p_job: jobId,
    p_item: itemId,
    p_token_hash: tokenHash,
    p_storage_cap_hash: storageCapHash,
    p_ttl_minutes: ttlMinutes,
  });
  if (error) throw databaseFault(error);
  const issued = data as {
    grantId: string; deliverableId: string; jobId: string; executionId: string;
    kind: DeliverableKind; expiresAt: string; activeVersionNumber: number;
  };
  return {
    grant: {
      grantId: issued.grantId,
      deliverableId: issued.deliverableId,
      jobId: issued.jobId,
      executionId: issued.executionId,
      kind: issued.kind,
      uploadUrl: config.origin + artifactRevisionPath(issued.jobId, issued.executionId, issued.deliverableId),
      uploadToken,
      expiresAt: issued.expiresAt,
      activeVersionNumber: issued.activeVersionNumber,
      documentStatusDefault: "draft",
    },
  };
}

const allowedRevisionFields = new Set(["file", "sha256", "documentStatus", "revisionNote", "expectedActiveVersion"]);

export async function uploadArtifactRevision(
  request: Request, config: AppConfig, job: string, execution: string, item: string,
  clientFactory: (headers: Record<string, string>) => SupabaseClient = headers => createPublicClient(config, headers),
  keyMaterial?: Uint8Array,
) {
  const supplied = request.headers.get("authorization")?.match(/^Bearer ([0-9a-f]{64})$/)?.[1];
  assert(supplied, 401, "UNAUTHORIZED_CALLBACK", "Autentikasi revisi tidak valid.");
  const key = keyMaterial ?? readWebhookConfig().callbackKeyMaterial;
  const tokenHash = checksum(Buffer.from(supplied, "utf8"));
  const storageCap = revisionStorageCapability(key, job, execution, item, tokenHash);
  const client = clientFactory({ "x-qa-storage-capability": storageCap });

  const identity = { p_job: job, p_execution: execution, p_item: item, p_token_hash: tokenHash };
  const lookup = await client.rpc("qa_artifact_revision_item", identity).single<ArtifactRow>();
  if (lookup.error) throw databaseFault(lookup.error);

  const contentType = request.headers.get("content-type");
  assert(contentType && /^multipart\/form-data\s*;/i.test(contentType), 415, "MULTIPART_REQUIRED", "Gunakan multipart/form-data.");
  const raw = await boundedBytes(request, MULTIPART_MAX_BYTES);
  const form = await new Response(new Uint8Array(raw), { headers: { "Content-Type": contentType } }).formData()
    .catch(() => { throw new Fault(400, "INVALID_MULTIPART", "Form multipart tidak valid."); });

  const keys = [...form.keys()];
  assert(new Set(keys).size === keys.length && keys.every(k => allowedRevisionFields.has(k)),
    400, "INVALID_MULTIPART", "Field multipart revisi tidak sesuai kontrak.");
  const file = form.get("file");
  const sha = form.get("sha256");
  const rawStatus = form.get("documentStatus");
  const rawNote = form.get("revisionNote");
  const rawExpected = form.get("expectedActiveVersion");
  assert(file instanceof File && typeof sha === "string" && /^[0-9a-f]{64}$/.test(sha),
    400, "INVALID_MULTIPART", "Kirim satu file dan satu SHA-256 lowercase.");
  assert(rawStatus === null || rawStatus === "draft",
    400, "INVALID_REQUEST", "Unggah revisi hanya mendukung documentStatus=draft.");
  assert(rawNote === null || (typeof rawNote === "string" && rawNote.length <= 500),
    400, "INVALID_REQUEST", "Catatan revisi maksimal 500 karakter.");
  let expectedActiveVersion: number | null = null;
  if (rawExpected !== null) {
    assert(typeof rawExpected === "string" && /^[1-9][0-9]{0,8}$/.test(rawExpected),
      400, "INVALID_REQUEST", "expectedActiveVersion harus bilangan bulat positif.");
    expectedActiveVersion = Number(rawExpected);
  }

  assert(file.size <= ARTIFACT_MAX_BYTES, 413, "BODY_TOO_LARGE", "File melebihi 3 MiB.");
  assert(file.size > 0, 400, "INVALID_ARTIFACT", "File kosong.");
  const bytes = Buffer.from(await file.arrayBuffer());
  assert(checksum(bytes) === sha, 400, "CHECKSUM_MISMATCH", "Checksum file tidak cocok.");
  assert(validArtifact(lookup.data.kind, file.name, bytes), 415, "INVALID_ARTIFACT_FORMAT", "Format file tidak sesuai jenis deliverable.");

  const reserved = await client.rpc("qa_reserve_artifact_revision", {
    ...identity,
    p_name: file.name,
    p_size: bytes.length,
    p_sha: sha,
    p_document_status: "draft",
    p_revision_note: typeof rawNote === "string" ? rawNote : "",
    p_expected_active_version: expectedActiveVersion,
  });
  if (reserved.error) throw databaseFault(reserved.error);

  const reservedData = reserved.data as {
    version: ArtifactVersionRow; replay: boolean; alreadyReady: boolean;
    activeVersionId: string | null; activeVersionNumber: number;
  };
  const reservedRow = reservedData.version;
  if (reservedData.alreadyReady) {
    return {
      status: 200 as const,
      payload: {
        version: versionDto(reservedRow, reservedData.activeVersionId),
        replay: true,
        activated: false,
        activeVersionNumber: reservedData.activeVersionNumber,
      },
    };
  }

  const storage = client.storage.from(bucket);
  const { error: uploadError } = await storage.upload(reservedRow.object_name, new Uint8Array(bytes), {
    contentType: "application/octet-stream", upsert: false,
  });
  if (uploadError) {
    const { data } = await storage.download(reservedRow.object_name);
    assert(data && data.size === bytes.length && checksum(Buffer.from(await data.arrayBuffer())) === sha,
      503, "ARTIFACT_STORAGE_UNAVAILABLE", "File revisi belum tersimpan. Versi aktif tidak berubah; coba ulang dengan file yang sama.");
  }

  const finished = await client.rpc("qa_finish_artifact_revision", {
    ...identity,
    p_version_id: reservedRow.version_id,
    p_sha: sha,
    p_expected_active_version: expectedActiveVersion,
  });
  if (finished.error) throw databaseFault(finished.error);
  const finishedData = finished.data as {
    version: ArtifactVersionRow; activated: boolean;
    activeVersionId: string | null; activeVersionNumber: number;
  };
  return {
    status: (uploadError ? 200 : 201) as 200 | 201,
    payload: {
      version: versionDto(finishedData.version, finishedData.activeVersionId),
      replay: Boolean(uploadError),
      activated: finishedData.activated,
      activeVersionNumber: finishedData.activeVersionNumber,
    },
  };
}

async function downloadWithItemCapability(config: AppConfig, identity: Pick<ArtifactRow, "job_id" | "execution_id" | "deliverable_id">, objectPath: string) {
  const key = readWebhookConfig().callbackKeyMaterial;
  const client = createPublicClient(config, {
    "x-qa-storage-capability": storageCapability(key, identity.job_id, identity.execution_id, identity.deliverable_id),
  });
  const { data, error } = await client.storage.from(bucket).download(objectPath);
  return error ? null : data;
}

export async function downloadArtifact(
  client: SupabaseClient, config: AppConfig, ownerId: string, jobId: string, itemId: string, versionId?: string,
) {
  let target: {
    owner_id: string; job_id: string; execution_id: string; deliverable_id: string;
    kind: DeliverableKind; file_name: string | null; size_bytes: number | null; sha256: string | null;
    objectPath: string;
  };

  if (versionId) {
    const [{ data: version, error: versionError }, { data: item, error: itemError }] = await Promise.all([
      client.from("qa_artifact_versions").select(versionColumns)
        .eq("owner_id", ownerId).eq("job_id", jobId).eq("deliverable_id", itemId).eq("version_id", versionId)
        .not("ready_at", "is", null).maybeSingle<ArtifactVersionRow>(),
      client.from("qa_artifacts").select("kind")
        .eq("owner_id", ownerId).eq("job_id", jobId).eq("deliverable_id", itemId)
        .maybeSingle<{ kind: DeliverableKind }>(),
    ]);
    if (versionError) throw databaseFault(versionError);
    if (itemError) throw databaseFault(itemError);
    assert(version && item, 404, "ARTIFACT_NOT_FOUND", "Versi file tidak ditemukan.");
    target = {
      owner_id: version.owner_id,
      job_id: version.job_id,
      execution_id: version.execution_id,
      deliverable_id: version.deliverable_id,
      kind: item.kind,
      file_name: version.file_name,
      size_bytes: version.size_bytes,
      sha256: version.sha256,
      objectPath: version.object_name,
    };
  } else {
    const { data, error } = await client.from("qa_artifacts").select(columns)
      .eq("owner_id", ownerId).eq("job_id", jobId).eq("deliverable_id", itemId)
      .not("ready_at", "is", null).maybeSingle<ArtifactRow>();
    if (error) throw databaseFault(error);
    assert(data, 404, "ARTIFACT_NOT_FOUND", "File tidak ditemukan.");
    target = { ...data, objectPath: activeObjectPath(data) };
  }

  // The caller already verified this user with Auth. Forward the session only as a
  // credential for Storage's authenticated object route, where RLS also checks ownership.
  const { data: auth, error: authError } = await client.auth.getSession();
  assert(!authError && auth.session?.access_token && auth.session.user.id === ownerId,
    401, "AUTH_REQUIRED", "Sesi berakhir. Silakan masuk kembali.");
  const path = target.objectPath.split("/").map(encodeURIComponent).join("/");
  const url = new URL(`/storage/v1/object/authenticated/${bucket}/${path}`, config.supabaseUrl);
  const stored = await fetch(url, {
    headers: { apikey: config.publishableKey, Authorization: `Bearer ${auth.session.access_token}` },
    cache: "no-store", redirect: "error", signal: AbortSignal.timeout(8000),
  }).catch(() => null);
  let file: Response | null = stored;
  if (stored && [400, 403, 404].includes(stored.status)) {
    // The session and owner-scoped ready row have already been checked. The
    // fallback is constrained to the same immutable object by Storage RLS.
    const itemFile = await downloadWithItemCapability(config, target, target.objectPath).catch(() => null);
    if (itemFile) {
      await stored.body?.cancel().catch(() => {});
      file = new Response(itemFile);
    }
  }
  if (file && !file.ok) {
    const body = await boundedBytes(file, 4096).then(bytes => JSON.parse(bytes.toString("utf8"))).catch(() => null);
    const rawCode = body?.code ?? body?.error;
    const known = ["NoSuchKey", "NoSuchBucket", "AccessDenied", "InvalidJWT", "InvalidRequest", "not_found", "Unauthorized"];
    const reason = known.find(code => code === rawCode);
    throw new Fault(503, "ARTIFACT_STORAGE_REJECTED",
      `Penyimpanan menolak unduhan (HTTP ${file.status}${reason ? `, ${reason}` : ""}).`);
  }
  assert(file?.body, 503, "ARTIFACT_STORAGE_UNAVAILABLE", "Penyimpanan tidak mengembalikan file. Coba lagi.");
  const bytes = await boundedBytes(file, ARTIFACT_MAX_BYTES).catch(() => {
    throw new Fault(503, "ARTIFACT_STORAGE_UNAVAILABLE", "File dari penyimpanan tidak dapat dibaca.");
  });
  assert(target.file_name && target.size_bytes === bytes.length && target.sha256 === checksum(bytes) &&
    validArtifact(target.kind, target.file_name, bytes), 503, "ARTIFACT_INTEGRITY_FAILED", "Integritas file tidak dapat dikonfirmasi.");
  return new Response(new Uint8Array(bytes), { headers: {
    "Cache-Control": "private, no-store",
    "Content-Type": "application/octet-stream",
    "Content-Length": String(bytes.length),
    "Content-Disposition": `attachment; filename="${target.file_name}"`,
    "X-Content-Type-Options": "nosniff",
  } });
}
