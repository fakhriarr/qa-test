-- Additive migration over 004_qa_requests_artifacts.sql and 005_qa_storage_download_info.sql.
-- Keeps targetUrl fragment-free while allowing optional non-empty #fragment anchors in scopeUrls
-- during draft submission, matching src/contracts/requests.ts (requestUrl vs scopeUrl).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION public.qa_submit_draft(p_draft uuid, p_revision integer)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE u uuid := public.qa_actor(); d public.qa_request_drafts; j uuid; v jsonb; input jsonb; criteria jsonb;
BEGIN
  SELECT * INTO d FROM public.qa_request_drafts WHERE owner_id = u AND draft_id = p_draft FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'DRAFT_NOT_FOUND' USING ERRCODE = 'PT404'; END IF;
  IF d.revision IS DISTINCT FROM p_revision THEN RAISE EXCEPTION 'DRAFT_CONFLICT' USING ERRCODE = 'PT409'; END IF;
  IF d.job_id IS NOT NULL THEN RETURN d.job_id; END IF;
  v := '{"accessRequiresLogin":false,"accessNotes":"","suggestions":"","prohibitions":""}'::jsonb || d.data;
  PERFORM public.qa_validate_draft(v);
  IF NOT (v ?& ARRAY['environment','scopeUrls','deliverables','acceptanceCriteria','targetUrl'])
    OR jsonb_array_length(v->'scopeUrls') = 0 OR jsonb_array_length(v->'deliverables') = 0
    OR (SELECT count(DISTINCT value) FROM jsonb_array_elements(v->'deliverables')) <> jsonb_array_length(v->'deliverables')
    OR (v->>'targetUrl') !~ '^https?://([^/@?#[:space:][:cntrl:]]+)([/?][^#[:space:][:cntrl:]]*)?$'
    OR position(chr(92) in (v->>'targetUrl')) > 0
    OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(v->'scopeUrls') AS urls(value)
      WHERE value !~ '^https?://([^/@?#[:space:][:cntrl:]]+)([/?][^#[:space:][:cntrl:]]*)?(#[^#[:space:][:cntrl:]]+)?$'
        OR position(chr(92) in value) > 0)
    OR (SELECT count(DISTINCT regexp_replace(
        lower(substring(value from '^https?://[^/?#]+')) || substring(value from length(substring(value from '^https?://[^/?#]+')) + 1),
        '^(https?://[^/?#]+)(#|$)', '\1/\2'))
      FROM jsonb_array_elements_text(v->'scopeUrls') AS urls(value)) <> jsonb_array_length(v->'scopeUrls') THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE = 'PT400';
  END IF;
  SELECT jsonb_agg(btrim(value) ORDER BY ordinal) INTO criteria
    FROM jsonb_array_elements_text(v->'acceptanceCriteria') WITH ORDINALITY AS c(value, ordinal);
  input := jsonb_build_object('schemaVersion', 1, 'targetUrl', v->'targetUrl',
    'scope', 'Cakupan permintaan QA tersimpan di request.scopeUrls.', 'acceptanceCriteria', criteria,
    'deliverables', '["summary","checks","findings"]'::jsonb);
  PERFORM public.qa_validate_input(input);
  INSERT INTO public.qa_jobs(owner_id, input) VALUES (u, input) RETURNING job_id INTO j;
  INSERT INTO public.qa_artifacts(owner_id, job_id, execution_id, kind)
    SELECT u, j, jobs.execution_id, item.value FROM public.qa_jobs jobs
    CROSS JOIN jsonb_array_elements_text(v->'deliverables') AS item(value) WHERE jobs.job_id = j;
  UPDATE public.qa_request_drafts SET job_id = j, data = v, updated_at = clock_timestamp() WHERE draft_id = p_draft;
  RETURN j;
END; $$;

REVOKE ALL ON FUNCTION public.qa_submit_draft(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.qa_submit_draft(uuid, integer) TO authenticated;

COMMIT;
