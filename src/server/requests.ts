import "./only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { uuidSchema, type Job } from "../contracts";
import { draftDataSchema, revisionSchema, submissionSchema, type Draft, type DraftData, type ValidatedSubmission } from "../contracts/requests";
import { body, parse } from "./boundary";
import { databaseFault } from "./database-errors";
import { assert, Fault } from "./errors";
import { Store } from "./store";

type DraftRow = { draft_id: string; revision: number; data: DraftData; job_id: string | null; updated_at: string };
export const REQUEST_SCOPE_MARKER = "Cakupan permintaan QA tersimpan di request.scopeUrls.";
const draftColumns = "draft_id,revision,data,job_id,updated_at";

function draftDto(row: DraftRow): Draft {
  return { draftId: row.draft_id, revision: row.revision, data: row.data, jobId: row.job_id, updatedAt: row.updated_at };
}

async function getDraft(client: SupabaseClient, id: string): Promise<Draft> {
  const { data, error } = await client.from("qa_request_drafts").select(draftColumns).eq("draft_id", id).maybeSingle();
  if (error) throw databaseFault(error);
  assert(data, 404, "DRAFT_NOT_FOUND", "Draf tidak ditemukan.");
  return draftDto(data);
}

export async function submittedRequest(client: SupabaseClient, jobId: string): Promise<ValidatedSubmission | null> {
  const { data, error } = await client.from("qa_request_drafts").select("data").eq("job_id", jobId).maybeSingle();
  if (error) throw databaseFault(error);
  return data ? parse(submissionSchema, data.data) : null;
}

type DraftResponse = { drafts: Draft[] } | { draft: Draft } | { job: Job };
export async function handleDrafts(
  request: Request, client: SupabaseClient,
  id: string | undefined, submit: boolean,
): Promise<{ payload: DraftResponse; status: number }> {
  if (!id && request.method === "GET") {
    const { data, error } = await client.from("qa_request_drafts").select(draftColumns).is("job_id", null)
      .order("updated_at", { ascending: false }).order("draft_id", { ascending: false }).limit(100);
    if (error) throw databaseFault(error);
    return { payload: { drafts: data.map(draftDto) }, status: 200 };
  }

  if (!id && request.method === "POST") {
    const draftId = parse(uuidSchema, request.headers.get("idempotency-key"));
    const input = await body(request, draftDataSchema);
    const { data, error } = await client.rpc("qa_save_draft", {
      p_draft: draftId, p_revision: null, p_data: input,
    });
    if (error) throw databaseFault(error);
    return { payload: { draft: draftDto(data.draft) }, status: data.replay ? 200 : 201 };
  }

  if (id && !submit && request.method === "GET") {
    return { payload: { draft: await getDraft(client, id) }, status: 200 };
  }

  if (id && !submit && request.method === "PUT") {
    const input = await body(request, z.strictObject({ revision: revisionSchema, data: draftDataSchema }));
    const { data, error } = await client.rpc("qa_save_draft", {
      p_draft: id, p_revision: input.revision, p_data: input.data,
    });
    if (error) throw databaseFault(error);
    return { payload: { draft: draftDto(data.draft) }, status: 200 };
  }

  if (id && submit && request.method === "POST") {
    const { revision } = await body(request, z.strictObject({ revision: revisionSchema }));
    const draft = await getDraft(client, id);
    assert(draft.revision === revision, 409, "DRAFT_CONFLICT", "Draf sudah berubah. Muat ulang.");
    parse(submissionSchema, draft.data);
    const { data: jobId, error } = await client.rpc("qa_submit_draft", {
      p_draft: id, p_revision: revision,
    });
    if (error) throw databaseFault(error);
    return { payload: { job: await new Store(client).job(jobId) }, status: 200 };
  }
  throw new Fault(405, "METHOD_NOT_ALLOWED", "Method tidak diizinkan.");
}
