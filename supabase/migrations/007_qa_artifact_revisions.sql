-- Additive migration over 004_qa_requests_artifacts.sql, 005_qa_storage_download_info.sql,
-- and 006_qa_scope_url_fragments.sql for immutable deliverable revisions on the same QA job.
-- Preserves existing qa_jobs, qa_artifacts, bug reports, initial upload semantics, and Storage immutability.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE public.qa_artifact_versions (
  version_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deliverable_id uuid NOT NULL REFERENCES public.qa_artifacts(deliverable_id),
  owner_id uuid NOT NULL,
  job_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  version_number integer NOT NULL CHECK (version_number >= 1),
  file_name text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 120),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 3145728),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  document_status text NOT NULL DEFAULT 'draft' CHECK (document_status IN ('draft', 'final')),
  revision_note text NOT NULL DEFAULT '' CHECK (length(revision_note) <= 500),
  object_name text NOT NULL UNIQUE,
  ready_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (deliverable_id, version_number),
  FOREIGN KEY (owner_id, job_id, execution_id) REFERENCES public.qa_jobs(owner_id, job_id, execution_id)
);

CREATE INDEX qa_artifact_versions_item_ready
  ON public.qa_artifact_versions(owner_id, job_id, deliverable_id, version_number DESC)
  WHERE ready_at IS NOT NULL;

CREATE INDEX qa_artifact_versions_item_fingerprint
  ON public.qa_artifact_versions(deliverable_id, sha256, file_name, size_bytes);

ALTER TABLE public.qa_artifact_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.qa_artifact_versions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.qa_artifact_versions TO authenticated;

CREATE POLICY qa_artifact_versions_read_owner ON public.qa_artifact_versions
  FOR SELECT TO authenticated
  USING (
    owner_id = (SELECT auth.uid())
    AND ready_at IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.qa_members WHERE user_id = (SELECT auth.uid()) AND active)
  );

ALTER TABLE public.qa_artifacts
  ADD COLUMN active_version_id uuid REFERENCES public.qa_artifact_versions(version_id),
  ADD COLUMN active_version_number integer NOT NULL DEFAULT 0 CHECK (active_version_number >= 0),
  ADD COLUMN document_status text NOT NULL DEFAULT 'draft' CHECK (document_status IN ('draft', 'final'));

-- Backfill every already-ready deliverable as immutable version 1 pointing to its existing Storage object.
INSERT INTO public.qa_artifact_versions (
  deliverable_id, owner_id, job_id, execution_id,
  version_number, file_name, size_bytes, sha256,
  document_status, revision_note, object_name, ready_at, created_at
)
SELECT
  a.deliverable_id, a.owner_id, a.job_id, a.execution_id,
  1, a.file_name, a.size_bytes, a.sha256,
  'draft', '', a.object_name, a.ready_at, COALESCE(a.ready_at, clock_timestamp())
FROM public.qa_artifacts a
WHERE a.ready_at IS NOT NULL
  AND a.file_name IS NOT NULL
  AND a.size_bytes IS NOT NULL
  AND a.sha256 IS NOT NULL
ON CONFLICT (deliverable_id, version_number) DO NOTHING;

UPDATE public.qa_artifacts a
SET
  active_version_id = v.version_id,
  active_version_number = v.version_number,
  document_status = v.document_status
FROM public.qa_artifact_versions v
WHERE v.deliverable_id = a.deliverable_id
  AND v.version_number = 1
  AND a.ready_at IS NOT NULL
  AND a.active_version_id IS NULL;

-- Least-privilege, time-bounded, item-scoped revision upload grants issued by the authenticated owner.
CREATE TABLE public.qa_artifact_revision_grants (
  grant_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deliverable_id uuid NOT NULL REFERENCES public.qa_artifacts(deliverable_id),
  owner_id uuid NOT NULL,
  job_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  storage_cap_hash text NOT NULL CHECK (storage_cap_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (owner_id, job_id, execution_id) REFERENCES public.qa_jobs(owner_id, job_id, execution_id)
);

CREATE INDEX qa_artifact_revision_grants_item
  ON public.qa_artifact_revision_grants(deliverable_id, expires_at DESC)
  WHERE revoked_at IS NULL;

ALTER TABLE public.qa_artifact_revision_grants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.qa_artifact_revision_grants FROM PUBLIC, anon, authenticated;

-- Extend Storage RLS helper to cover versioned objects while preserving strict immutability and no listing/public/signed access.
CREATE OR REPLACE FUNCTION public.qa_storage_object_allowed(p_name text, p_write boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.qa_artifacts a
    JOIN public.qa_members m ON m.user_id = a.owner_id AND m.active
    LEFT JOIN public.qa_artifact_upload_caps c ON c.deliverable_id = a.deliverable_id
    WHERE a.object_name = p_name AND (
      (NOT p_write
        AND storage.allow_any_operation(ARRAY[
          'object.get_authenticated',
          'object.get_authenticated_info',
          'object.head_authenticated_info',
          'object.info_authenticated'
        ])
        AND a.ready_at IS NOT NULL
        AND a.owner_id = (SELECT auth.uid()))
      OR ((SELECT auth.uid()) IS NULL AND a.sha256 IS NOT NULL
        AND (NOT p_write OR a.ready_at IS NULL)
        AND c.secret_hash = (SELECT public.qa_storage_cap_hash()))
    )
  )
  OR EXISTS (
    SELECT 1 FROM public.qa_artifact_versions v
    JOIN public.qa_members m ON m.user_id = v.owner_id AND m.active
    WHERE v.object_name = p_name AND (
      (NOT p_write
        AND storage.allow_any_operation(ARRAY[
          'object.get_authenticated',
          'object.get_authenticated_info',
          'object.head_authenticated_info',
          'object.info_authenticated'
        ])
        AND v.ready_at IS NOT NULL
        AND v.owner_id = (SELECT auth.uid()))
      OR ((SELECT auth.uid()) IS NULL
        AND (NOT p_write OR v.ready_at IS NULL)
        AND EXISTS (
          SELECT 1 FROM public.qa_artifact_revision_grants g
          WHERE g.deliverable_id = v.deliverable_id
            AND g.revoked_at IS NULL
            AND g.expires_at > clock_timestamp()
            AND g.storage_cap_hash = (SELECT public.qa_storage_cap_hash())
        ))
      OR ((SELECT auth.uid()) IS NULL
        AND NOT p_write
        AND v.ready_at IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM public.qa_artifact_upload_caps c
          WHERE c.deliverable_id = v.deliverable_id
            AND c.secret_hash = (SELECT public.qa_storage_cap_hash())
        ))
    )
  )
$$;

-- Keep initial upload RPC strict and record version 1 atomically for all future initial uploads.
CREATE OR REPLACE FUNCTION public.qa_finish_artifact(p_job uuid, p_execution uuid, p_item uuid, p_sha text)
RETURNS public.qa_artifacts LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.qa_artifacts; v public.qa_artifact_versions; ts timestamptz := clock_timestamp();
BEGIN
  a := public.qa_artifact_upload_item(p_job, p_execution, p_item);
  SELECT * INTO a FROM public.qa_artifacts WHERE deliverable_id = p_item FOR UPDATE;
  IF a.sha256 IS NULL OR a.sha256 IS DISTINCT FROM p_sha THEN RAISE EXCEPTION 'ARTIFACT_CONFLICT' USING ERRCODE = 'PT409'; END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.objects
    WHERE bucket_id = 'qa-deliverables' AND name = a.object_name AND (metadata->>'size') = a.size_bytes::text) THEN
    RAISE EXCEPTION 'ARTIFACT_STORAGE_UNAVAILABLE' USING ERRCODE = 'PT503';
  END IF;
  INSERT INTO public.qa_artifact_versions (
    deliverable_id, owner_id, job_id, execution_id,
    version_number, file_name, size_bytes, sha256,
    document_status, revision_note, object_name, ready_at, created_at
  ) VALUES (
    a.deliverable_id, a.owner_id, a.job_id, a.execution_id,
    1, a.file_name, a.size_bytes, a.sha256,
    'draft', '', a.object_name, COALESCE(a.ready_at, ts), COALESCE(a.ready_at, ts)
  )
  ON CONFLICT (deliverable_id, version_number) DO NOTHING;

  SELECT * INTO v FROM public.qa_artifact_versions WHERE deliverable_id = a.deliverable_id AND version_number = 1;
  UPDATE public.qa_artifacts SET
    ready_at = COALESCE(ready_at, v.ready_at),
    active_version_id = COALESCE(active_version_id, v.version_id),
    active_version_number = CASE WHEN active_version_number = 0 THEN 1 ELSE active_version_number END
  WHERE deliverable_id = p_item RETURNING * INTO a;
  RETURN a;
END; $$;

-- Owner issues a scoped, expiring revision upload grant for one ready deliverable (works on terminal jobs too).
CREATE OR REPLACE FUNCTION public.qa_issue_artifact_revision_grant(
  p_job uuid,
  p_item uuid,
  p_token_hash text,
  p_storage_cap_hash text,
  p_ttl_minutes integer DEFAULT 1440
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE u uuid := public.qa_actor(); a public.qa_artifacts; g public.qa_artifact_revision_grants;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$'
    OR p_storage_cap_hash IS NULL OR p_storage_cap_hash !~ '^[0-9a-f]{64}$'
    OR p_ttl_minutes IS NULL OR p_ttl_minutes NOT BETWEEN 5 AND 4320 THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE = 'PT400';
  END IF;
  SELECT * INTO a FROM public.qa_artifacts
    WHERE owner_id = u AND job_id = p_job AND deliverable_id = p_item FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ARTIFACT_NOT_FOUND' USING ERRCODE = 'PT404'; END IF;
  IF a.ready_at IS NULL THEN RAISE EXCEPTION 'ARTIFACT_NOT_READY' USING ERRCODE = 'PT409'; END IF;
  INSERT INTO public.qa_artifact_revision_grants (
    deliverable_id, owner_id, job_id, execution_id, token_hash, storage_cap_hash, expires_at
  ) VALUES (
    a.deliverable_id, a.owner_id, a.job_id, a.execution_id,
    p_token_hash, p_storage_cap_hash, clock_timestamp() + make_interval(mins => p_ttl_minutes)
  ) RETURNING * INTO g;
  RETURN jsonb_build_object(
    'grantId', g.grant_id,
    'deliverableId', a.deliverable_id,
    'jobId', a.job_id,
    'executionId', a.execution_id,
    'kind', a.kind,
    'expiresAt', g.expires_at,
    'activeVersionNumber', a.active_version_number
  );
END; $$;

-- Verify an active, scoped revision grant and return item metadata without exposing hashes.
CREATE OR REPLACE FUNCTION public.qa_artifact_revision_item(
  p_job uuid,
  p_execution uuid,
  p_item uuid,
  p_token_hash text
) RETURNS public.qa_artifacts LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.qa_artifacts;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'UNAUTHORIZED_CALLBACK' USING ERRCODE = 'PT401';
  END IF;
  SELECT item.* INTO a FROM public.qa_artifacts item
  JOIN public.qa_artifact_revision_grants g ON g.deliverable_id = item.deliverable_id
  JOIN public.qa_members m ON m.user_id = item.owner_id AND m.active
  WHERE item.job_id = p_job
    AND item.execution_id = p_execution
    AND item.deliverable_id = p_item
    AND g.token_hash = p_token_hash
    AND g.revoked_at IS NULL
    AND g.expires_at > clock_timestamp()
    AND g.storage_cap_hash = public.qa_storage_cap_hash();
  IF NOT FOUND THEN RAISE EXCEPTION 'UNAUTHORIZED_CALLBACK' USING ERRCODE = 'PT401'; END IF;
  IF a.ready_at IS NULL THEN RAISE EXCEPTION 'ARTIFACT_NOT_READY' USING ERRCODE = 'PT409'; END IF;
  RETURN a;
END; $$;

-- Reserve an immutable revision version safely under FOR UPDATE lock.
-- Identical retries of active or superseded versions return replay=true without duplicating or reactivating old versions.
CREATE OR REPLACE FUNCTION public.qa_reserve_artifact_revision(
  p_job uuid,
  p_execution uuid,
  p_item uuid,
  p_token_hash text,
  p_name text,
  p_size integer,
  p_sha text,
  p_document_status text DEFAULT 'draft',
  p_revision_note text DEFAULT '',
  p_expected_active_version integer DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.qa_artifacts; v public.qa_artifact_versions; next_ver integer; new_id uuid; obj text;
BEGIN
  PERFORM public.qa_artifact_revision_item(p_job, p_execution, p_item, p_token_hash);
  SELECT * INTO a FROM public.qa_artifacts WHERE deliverable_id = p_item FOR UPDATE;
  IF a.ready_at IS NULL THEN RAISE EXCEPTION 'ARTIFACT_NOT_READY' USING ERRCODE = 'PT409'; END IF;
  IF p_name IS NULL OR p_name !~ '^[A-Za-z0-9][A-Za-z0-9_. -]{0,119}$'
    OR p_size IS NULL OR p_size NOT BETWEEN 1 AND 3145728
    OR p_sha IS NULL OR p_sha !~ '^[0-9a-f]{64}$'
    OR p_document_status IS NULL OR p_document_status <> 'draft'
    OR p_revision_note IS NULL OR length(p_revision_note) > 500 THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE = 'PT400';
  END IF;

  -- Check identical already-ready version first: never duplicate and never reactivate a superseded version.
  SELECT * INTO v FROM public.qa_artifact_versions
    WHERE deliverable_id = p_item AND sha256 = p_sha AND file_name = p_name AND size_bytes = p_size AND ready_at IS NOT NULL
    ORDER BY version_number DESC LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'version', to_jsonb(v),
      'replay', true,
      'alreadyReady', true,
      'activeVersionId', a.active_version_id,
      'activeVersionNumber', a.active_version_number
    );
  END IF;

  -- Reuse an interrupted pending reservation for the exact same file.
  SELECT * INTO v FROM public.qa_artifact_versions
    WHERE deliverable_id = p_item AND sha256 = p_sha AND file_name = p_name AND size_bytes = p_size AND ready_at IS NULL
    ORDER BY version_number DESC LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'version', to_jsonb(v),
      'replay', false,
      'alreadyReady', false,
      'activeVersionId', a.active_version_id,
      'activeVersionNumber', a.active_version_number
    );
  END IF;

  IF p_expected_active_version IS NOT NULL AND a.active_version_number IS DISTINCT FROM p_expected_active_version THEN
    RAISE EXCEPTION 'ARTIFACT_VERSION_CONFLICT' USING ERRCODE = 'PT409';
  END IF;

  SELECT COALESCE(MAX(version_number), 0) + 1 INTO next_ver FROM public.qa_artifact_versions WHERE deliverable_id = p_item;
  new_id := gen_random_uuid();
  obj := a.owner_id::text || '/' || a.job_id::text || '/' || a.execution_id::text || '/' || a.deliverable_id::text || '/v/' || new_id::text;

  INSERT INTO public.qa_artifact_versions (
    version_id, deliverable_id, owner_id, job_id, execution_id,
    version_number, file_name, size_bytes, sha256,
    document_status, revision_note, object_name
  ) VALUES (
    new_id, a.deliverable_id, a.owner_id, a.job_id, a.execution_id,
    next_ver, p_name, p_size, p_sha,
    p_document_status, p_revision_note, obj
  ) RETURNING * INTO v;

  RETURN jsonb_build_object(
    'version', to_jsonb(v),
    'replay', false,
    'alreadyReady', false,
    'activeVersionId', a.active_version_id,
    'activeVersionNumber', a.active_version_number
  );
END; $$;

-- Atomically finalize and activate a reserved revision version after confirming Storage object persistence.
-- Never mutates qa_jobs or other deliverables; never downgrades active_version_number on race.
CREATE OR REPLACE FUNCTION public.qa_finish_artifact_revision(
  p_job uuid,
  p_execution uuid,
  p_item uuid,
  p_token_hash text,
  p_version_id uuid,
  p_sha text,
  p_expected_active_version integer DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.qa_artifacts; v public.qa_artifact_versions; ts timestamptz := clock_timestamp(); activated boolean := false;
BEGIN
  PERFORM public.qa_artifact_revision_item(p_job, p_execution, p_item, p_token_hash);
  SELECT * INTO a FROM public.qa_artifacts WHERE deliverable_id = p_item FOR UPDATE;
  SELECT * INTO v FROM public.qa_artifact_versions WHERE deliverable_id = p_item AND version_id = p_version_id FOR UPDATE;
  IF NOT FOUND OR v.sha256 IS DISTINCT FROM p_sha THEN
    RAISE EXCEPTION 'ARTIFACT_CONFLICT' USING ERRCODE = 'PT409';
  END IF;
  IF v.ready_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'version', to_jsonb(v),
      'activated', a.active_version_id = v.version_id,
      'activeVersionId', a.active_version_id,
      'activeVersionNumber', a.active_version_number
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.objects
    WHERE bucket_id = 'qa-deliverables' AND name = v.object_name AND (metadata->>'size') = v.size_bytes::text) THEN
    RAISE EXCEPTION 'ARTIFACT_STORAGE_UNAVAILABLE' USING ERRCODE = 'PT503';
  END IF;
  IF p_expected_active_version IS NOT NULL AND a.active_version_number IS DISTINCT FROM p_expected_active_version THEN
    RAISE EXCEPTION 'ARTIFACT_VERSION_CONFLICT' USING ERRCODE = 'PT409';
  END IF;

  UPDATE public.qa_artifact_versions SET ready_at = ts WHERE version_id = v.version_id RETURNING * INTO v;

  -- Only promote if strictly newer than current active version so a slow concurrent request cannot silently revert active.
  IF v.version_number > a.active_version_number THEN
    UPDATE public.qa_artifacts SET
      file_name = v.file_name,
      size_bytes = v.size_bytes,
      sha256 = v.sha256,
      ready_at = v.ready_at,
      active_version_id = v.version_id,
      active_version_number = v.version_number,
      document_status = v.document_status
    WHERE deliverable_id = p_item RETURNING * INTO a;
    activated := true;
  END IF;

  RETURN jsonb_build_object(
    'version', to_jsonb(v),
    'activated', activated,
    'activeVersionId', a.active_version_id,
    'activeVersionNumber', a.active_version_number
  );
END; $$;

REVOKE ALL ON FUNCTION public.qa_storage_object_allowed(text, boolean),
  public.qa_finish_artifact(uuid, uuid, uuid, text),
  public.qa_issue_artifact_revision_grant(uuid, uuid, text, text, integer),
  public.qa_artifact_revision_item(uuid, uuid, uuid, text),
  public.qa_reserve_artifact_revision(uuid, uuid, uuid, text, text, integer, text, text, text, integer),
  public.qa_finish_artifact_revision(uuid, uuid, uuid, text, uuid, text, integer)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.qa_storage_object_allowed(text, boolean) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.qa_finish_artifact(uuid, uuid, uuid, text) TO anon;
GRANT EXECUTE ON FUNCTION public.qa_issue_artifact_revision_grant(uuid, uuid, text, text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.qa_artifact_revision_item(uuid, uuid, uuid, text),
  public.qa_reserve_artifact_revision(uuid, uuid, uuid, text, text, integer, text, text, text, integer),
  public.qa_finish_artifact_revision(uuid, uuid, uuid, text, uuid, text, integer) TO anon;

COMMIT;
