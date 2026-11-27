BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Supabase Storage Smart CDN prechecks private object downloads via /object/info/authenticated/*
-- and /object/info/*, which set storage.operation() to 'object.get_authenticated_info' (or HEAD/info
-- equivalents) before 'storage.object.get_authenticated'. Allow only single-object authenticated
-- info/head/get operations while keeping list, public, signed-URL, update, and delete blocked.
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
$$;

ALTER POLICY qa_storage_select_fence ON storage.objects
  USING (bucket_id <> 'qa-deliverables' OR (
    storage.allow_any_operation(ARRAY[
      'object.get_authenticated',
      'object.get_authenticated_info',
      'object.head_authenticated_info',
      'object.info_authenticated',
      'object.upload'
    ])
    AND public.qa_storage_object_allowed(name, false)));

REVOKE ALL ON FUNCTION public.qa_storage_object_allowed(text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.qa_storage_object_allowed(text, boolean) TO anon, authenticated;

COMMIT;
