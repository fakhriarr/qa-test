BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE public.qa_request_drafts (
  draft_id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES auth.users(id),
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object' AND octet_length(data::text) <= 65536),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  job_id uuid UNIQUE,
  FOREIGN KEY (owner_id, job_id) REFERENCES public.qa_jobs(owner_id, job_id)
);
CREATE INDEX qa_request_drafts_latest ON public.qa_request_drafts(owner_id, updated_at DESC, draft_id DESC);

CREATE TABLE public.qa_artifacts (
  deliverable_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  job_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('test_plan','test_case','api_report','automation_script','security_report','performance_report','bug_report')),
  file_name text CHECK (length(file_name) BETWEEN 1 AND 120),
  size_bytes integer CHECK (size_bytes BETWEEN 1 AND 3145728),
  sha256 text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  ready_at timestamptz,
  object_name text GENERATED ALWAYS AS (owner_id::text || '/' || job_id::text || '/' || execution_id::text || '/' || deliverable_id::text) STORED UNIQUE,
  UNIQUE (job_id, execution_id, kind),
  FOREIGN KEY (owner_id, job_id, execution_id) REFERENCES public.qa_jobs(owner_id, job_id, execution_id),
  CHECK ((sha256 IS NULL AND file_name IS NULL AND size_bytes IS NULL AND ready_at IS NULL)
    OR (sha256 IS NOT NULL AND file_name IS NOT NULL AND size_bytes IS NOT NULL))
);

ALTER TABLE public.qa_request_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.qa_artifacts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.qa_request_drafts, public.qa_artifacts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.qa_request_drafts, public.qa_artifacts TO authenticated;
CREATE POLICY qa_drafts_read_owner ON public.qa_request_drafts FOR SELECT TO authenticated
  USING (owner_id = (SELECT auth.uid()) AND EXISTS (SELECT 1 FROM public.qa_members WHERE user_id = (SELECT auth.uid()) AND active));
CREATE POLICY qa_artifacts_read_owner ON public.qa_artifacts FOR SELECT TO authenticated
  USING (owner_id = (SELECT auth.uid()) AND EXISTS (SELECT 1 FROM public.qa_members WHERE user_id = (SELECT auth.uid()) AND active));

CREATE TABLE public.qa_artifact_upload_caps (
  deliverable_id uuid PRIMARY KEY REFERENCES public.qa_artifacts(deliverable_id),
  secret_hash text NOT NULL CHECK (secret_hash ~ '^[0-9a-f]{64}$')
);
ALTER TABLE public.qa_artifact_upload_caps ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.qa_artifact_upload_caps FROM PUBLIC, anon, authenticated;

INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('qa-deliverables', 'qa-deliverables', false, 3145728);

CREATE FUNCTION public.qa_validate_draft(p_data jsonb) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE k text; v jsonb; n integer; item jsonb;
BEGIN
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' OR octet_length(p_data::text) > 65536 THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE = 'PT400';
  END IF;
  FOR k, v IN SELECT key, value FROM jsonb_each(p_data) LOOP
    IF k IN ('targetUrl','suggestions','prohibitions','accessNotes') THEN
      IF jsonb_typeof(v) <> 'string' OR length(v #>> '{}') > (CASE WHEN k = 'targetUrl' THEN 2048 WHEN k = 'accessNotes' THEN 1000 ELSE 2000 END)
        OR (k = 'accessNotes' AND (v #>> '{}') ~* '(\m(password|passwd|kata sandi|token|api[_ -]?key|secret|otp)[[:space:]]*[:=]|\mbearer[[:space:]]+[[:alnum:]_.-]+|https?://[^[:space:]/?#]*@|-----BEGIN [^-]*PRIVATE KEY-----)') THEN
        RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE = 'PT400';
      END IF;
    ELSIF k = 'accessRequiresLogin' THEN
      IF jsonb_typeof(v) <> 'boolean' THEN RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE = 'PT400'; END IF;
    ELSIF k = 'environment' THEN
      IF jsonb_typeof(v) <> 'string' OR (v #>> '{}') NOT IN ('development','staging','production','other') THEN
        RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE = 'PT400';
      END IF;
    ELSIF k IN ('scopeUrls','acceptanceCriteria','deliverables') THEN
      n := CASE k WHEN 'scopeUrls' THEN 12 WHEN 'acceptanceCriteria' THEN 10 ELSE 7 END;
      IF jsonb_typeof(v) <> 'array' THEN RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE = 'PT400'; END IF;
      IF jsonb_array_length(v) > n THEN RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE = 'PT400'; END IF;
      FOR item IN SELECT value FROM jsonb_array_elements(v) LOOP
        IF jsonb_typeof(item) <> 'string'
          OR (k = 'scopeUrls' AND length(item #>> '{}') > 2048)
          OR (k = 'acceptanceCriteria' AND length(item #>> '{}') > 500)
          OR (k = 'deliverables' AND (item #>> '{}') NOT IN
            ('test_plan','test_case','api_report','automation_script','security_report','performance_report','bug_report')) THEN
          RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE = 'PT400';
        END IF;
      END LOOP;
    ELSE
      RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE = 'PT400';
    END IF;
  END LOOP;
END; $$;

CREATE FUNCTION public.qa_save_draft(p_draft uuid, p_revision integer, p_data jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE u uuid := public.qa_actor(); d public.qa_request_drafts; replay boolean := false;
BEGIN
  PERFORM public.qa_validate_draft(p_data);
  IF p_revision IS NULL THEN
    INSERT INTO public.qa_request_drafts(draft_id, owner_id, data) VALUES (p_draft, u, p_data)
      ON CONFLICT (draft_id) DO NOTHING RETURNING * INTO d;
    IF NOT FOUND THEN
      SELECT * INTO d FROM public.qa_request_drafts WHERE draft_id = p_draft AND owner_id = u FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'DRAFT_NOT_FOUND' USING ERRCODE = 'PT404'; END IF;
      IF d.revision <> 1 OR d.job_id IS NOT NULL OR d.data <> p_data THEN
        RAISE EXCEPTION 'DRAFT_CONFLICT' USING ERRCODE = 'PT409';
      END IF;
      replay := true;
    END IF;
  ELSE
    UPDATE public.qa_request_drafts SET data = p_data, revision = revision + 1, updated_at = clock_timestamp()
      WHERE draft_id = p_draft AND owner_id = u AND revision = p_revision AND revision < 2147483647 AND job_id IS NULL
      RETURNING * INTO d;
    IF NOT FOUND THEN
      IF NOT EXISTS (SELECT 1 FROM public.qa_request_drafts WHERE draft_id = p_draft AND owner_id = u) THEN
        RAISE EXCEPTION 'DRAFT_NOT_FOUND' USING ERRCODE = 'PT404';
      END IF;
      RAISE EXCEPTION 'DRAFT_CONFLICT' USING ERRCODE = 'PT409';
    END IF;
  END IF;
  RETURN jsonb_build_object('draft', to_jsonb(d) - 'owner_id', 'replay', replay);
END; $$;

CREATE FUNCTION public.qa_submit_draft(p_draft uuid, p_revision integer)
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
    OR (SELECT count(DISTINCT value) FROM jsonb_array_elements(v->'scopeUrls')) <> jsonb_array_length(v->'scopeUrls')
    OR EXISTS (SELECT 1 FROM jsonb_array_elements_text((v->'scopeUrls') || jsonb_build_array(v->'targetUrl')) AS urls(value)
      WHERE value !~ '^https?://([^/@?#[:space:]]+)([/?][^#[:space:]]*)?$' OR position(chr(92) in value) > 0) THEN
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

-- Only the owner can bind an upload capability and only to items of the specified execution.
CREATE FUNCTION public.qa_bind_artifact_uploads(p_job uuid, p_execution uuid, p_hashes jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE u uuid := public.qa_actor(); a public.qa_artifacts; h text; n integer := 0;
BEGIN
  IF jsonb_typeof(p_hashes) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE = 'PT400'; END IF;
  FOR a IN SELECT * FROM public.qa_artifacts WHERE owner_id = u AND job_id = p_job AND execution_id = p_execution
    ORDER BY deliverable_id LOOP
    h := p_hashes->>(a.deliverable_id::text);
    IF h IS NULL OR h !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE = 'PT400'; END IF;
    INSERT INTO public.qa_artifact_upload_caps(deliverable_id, secret_hash) VALUES (a.deliverable_id, h)
      ON CONFLICT (deliverable_id) DO NOTHING;
    IF NOT EXISTS (SELECT 1 FROM public.qa_artifact_upload_caps WHERE deliverable_id = a.deliverable_id AND secret_hash = h) THEN
      RAISE EXCEPTION 'ARTIFACT_CONFLICT' USING ERRCODE = 'PT409';
    END IF;
    n := n + 1;
  END LOOP;
  IF n = 0 THEN RAISE EXCEPTION 'ARTIFACT_NOT_FOUND' USING ERRCODE = 'PT404'; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p_hashes)) <> n THEN RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE = 'PT400'; END IF;
END; $$;

CREATE FUNCTION public.qa_storage_cap_hash() RETURNS text
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT CASE WHEN cap ~ '^[0-9a-f]{64}$' THEN encode(sha256(convert_to(cap,'UTF8')), 'hex') END
  FROM (SELECT nullif(current_setting('request.headers', true), '')::jsonb->>'x-qa-storage-capability' AS cap) h
$$;

CREATE FUNCTION public.qa_storage_object_allowed(p_name text, p_write boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.qa_artifacts a
    JOIN public.qa_members m ON m.user_id = a.owner_id AND m.active
    LEFT JOIN public.qa_artifact_upload_caps c ON c.deliverable_id = a.deliverable_id
    WHERE a.object_name = p_name AND (
      (NOT p_write AND storage.allow_only_operation('object.get_authenticated') AND a.ready_at IS NOT NULL AND a.owner_id = (SELECT auth.uid()))
      OR ((SELECT auth.uid()) IS NULL AND a.sha256 IS NOT NULL
        AND (NOT p_write OR a.ready_at IS NULL) AND c.secret_hash = (SELECT public.qa_storage_cap_hash()))
    )
  )
$$;

CREATE POLICY qa_storage_select ON storage.objects FOR SELECT TO anon, authenticated
  USING (bucket_id = 'qa-deliverables' AND public.qa_storage_object_allowed(name, false));
CREATE POLICY qa_storage_select_fence ON storage.objects AS RESTRICTIVE FOR SELECT TO anon, authenticated
  USING (bucket_id <> 'qa-deliverables' OR (
    storage.allow_any_operation(ARRAY['object.get_authenticated','object.upload'])
    AND public.qa_storage_object_allowed(name, false)));
CREATE POLICY qa_storage_insert ON storage.objects FOR INSERT TO anon
  WITH CHECK (bucket_id = 'qa-deliverables' AND public.qa_storage_object_allowed(name, true));
CREATE POLICY qa_storage_insert_fence ON storage.objects AS RESTRICTIVE FOR INSERT TO anon, authenticated
  WITH CHECK (bucket_id <> 'qa-deliverables' OR (
    storage.allow_only_operation('object.upload') AND public.qa_storage_object_allowed(name, true)));
CREATE POLICY qa_storage_update_fence ON storage.objects AS RESTRICTIVE FOR UPDATE TO anon, authenticated
  USING (bucket_id <> 'qa-deliverables') WITH CHECK (bucket_id <> 'qa-deliverables');
CREATE POLICY qa_storage_delete_fence ON storage.objects AS RESTRICTIVE FOR DELETE TO anon, authenticated
  USING (bucket_id <> 'qa-deliverables');

CREATE FUNCTION public.qa_artifact_upload_item(p_job uuid, p_execution uuid, p_item uuid)
RETURNS public.qa_artifacts LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.qa_artifacts;
BEGIN
  SELECT item.* INTO a FROM public.qa_artifacts item
  JOIN public.qa_artifact_upload_caps c USING (deliverable_id)
  JOIN public.qa_members m ON m.user_id = item.owner_id AND m.active
  WHERE item.job_id = p_job AND item.execution_id = p_execution AND item.deliverable_id = p_item
    AND c.secret_hash = public.qa_storage_cap_hash();
  IF NOT FOUND THEN RAISE EXCEPTION 'ARTIFACT_NOT_FOUND' USING ERRCODE = 'PT404'; END IF;
  RETURN a;
END; $$;

CREATE FUNCTION public.qa_reserve_artifact(p_job uuid, p_execution uuid, p_item uuid, p_name text, p_size integer, p_sha text)
RETURNS public.qa_artifacts LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE j public.qa_jobs; a public.qa_artifacts;
BEGIN
  PERFORM public.qa_artifact_upload_item(p_job, p_execution, p_item);
  SELECT * INTO j FROM public.qa_jobs WHERE job_id = p_job AND execution_id = p_execution FOR UPDATE;
  SELECT * INTO a FROM public.qa_artifacts WHERE deliverable_id = p_item FOR UPDATE;
  IF a.sha256 IS NOT NULL THEN
    IF (a.sha256, a.file_name, a.size_bytes) IS DISTINCT FROM (p_sha, p_name, p_size) THEN
      RAISE EXCEPTION 'ARTIFACT_CONFLICT' USING ERRCODE = 'PT409';
    END IF;
    RETURN a;
  END IF;
  IF j.execution_status IN ('succeeded','failed') OR j.delivery_status NOT IN ('sending','accepted','unknown') THEN
    RAISE EXCEPTION 'ARTIFACT_EXECUTION_INACTIVE' USING ERRCODE = 'PT409';
  END IF;
  IF p_name IS NULL OR p_name !~ '^[A-Za-z0-9][A-Za-z0-9_. -]{0,119}$' OR p_size IS NULL
    OR p_size NOT BETWEEN 1 AND 3145728 OR p_sha IS NULL OR p_sha !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE = 'PT400';
  END IF;
  UPDATE public.qa_artifacts SET sha256 = p_sha, file_name = p_name, size_bytes = p_size
    WHERE deliverable_id = p_item RETURNING * INTO a;
  RETURN a;
END; $$;

CREATE FUNCTION public.qa_finish_artifact(p_job uuid, p_execution uuid, p_item uuid, p_sha text)
RETURNS public.qa_artifacts LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.qa_artifacts;
BEGIN
  a := public.qa_artifact_upload_item(p_job, p_execution, p_item);
  IF a.sha256 IS NULL OR a.sha256 IS DISTINCT FROM p_sha THEN RAISE EXCEPTION 'ARTIFACT_CONFLICT' USING ERRCODE = 'PT409'; END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.objects
    WHERE bucket_id = 'qa-deliverables' AND name = a.object_name AND (metadata->>'size') = a.size_bytes::text) THEN
    RAISE EXCEPTION 'ARTIFACT_STORAGE_UNAVAILABLE' USING ERRCODE = 'PT503';
  END IF;
  UPDATE public.qa_artifacts SET ready_at = COALESCE(ready_at, clock_timestamp())
    WHERE deliverable_id = p_item RETURNING * INTO a;
  RETURN a;
END; $$;

REVOKE ALL ON FUNCTION public.qa_validate_draft(jsonb), public.qa_save_draft(uuid,integer,jsonb),
  public.qa_submit_draft(uuid,integer), public.qa_bind_artifact_uploads(uuid,uuid,jsonb), public.qa_storage_cap_hash(),
  public.qa_storage_object_allowed(text,boolean), public.qa_artifact_upload_item(uuid,uuid,uuid),
  public.qa_reserve_artifact(uuid,uuid,uuid,text,integer,text), public.qa_finish_artifact(uuid,uuid,uuid,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.qa_save_draft(uuid,integer,jsonb), public.qa_submit_draft(uuid,integer),
  public.qa_bind_artifact_uploads(uuid,uuid,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.qa_storage_object_allowed(text,boolean) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.qa_artifact_upload_item(uuid,uuid,uuid),
  public.qa_reserve_artifact(uuid,uuid,uuid,text,integer,text), public.qa_finish_artifact(uuid,uuid,uuid,text) TO anon;

COMMIT;
