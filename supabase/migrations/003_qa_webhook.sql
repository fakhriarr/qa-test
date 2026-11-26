-- Additive migration over 001_qa_schema_rls.sql and 002_qa_rpc.sql for OpenBot QA webhook dispatch and authenticated callbacks.
-- Apply once in Supabase SQL Editor after 001 and 002; no existing tables or rows are dropped or reset.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.qa_jobs
  ADD COLUMN callback_token_hash text
  CHECK (callback_token_hash IS NULL OR pg_catalog.length(callback_token_hash) = 64);

CREATE TABLE public.qa_agent_callback_receipts (
  event_id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  job_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  sequence smallint NOT NULL CHECK (sequence IN (1, 2)),
  fingerprint text NOT NULL CHECK (pg_catalog.length(fingerprint) = 64),
  applied boolean NOT NULL,
  received_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  FOREIGN KEY (owner_id, job_id, execution_id) REFERENCES public.qa_jobs(owner_id, job_id, execution_id)
);

CREATE INDEX qa_agent_callback_receipts_job
  ON public.qa_agent_callback_receipts(owner_id, job_id, execution_id);

ALTER TABLE public.qa_agent_callback_receipts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.qa_agent_callback_receipts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.qa_agent_callback_receipts TO authenticated;

CREATE POLICY qa_agent_receipts_read_owner ON public.qa_agent_callback_receipts FOR SELECT TO authenticated
  USING (owner_id = (SELECT auth.uid()) AND EXISTS (SELECT 1 FROM public.qa_members m WHERE m.user_id = (SELECT auth.uid()) AND m.active));

CREATE FUNCTION public.qa_validate_agent_callback(v jsonb, criterion_count integer) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE r jsonb; c jsonb; f jsonb; indexes integer[] := '{}'; i integer;
BEGIN
  IF v IS NULL OR pg_catalog.jsonb_typeof(v) IS DISTINCT FROM 'object'
    OR NOT (v ?& ARRAY['schemaVersion','mode','eventId','jobId','executionId','sequence','eventType','result','error'])
    OR v - ARRAY['schemaVersion','mode','eventId','jobId','executionId','sequence','eventType','result','error'] <> '{}'::jsonb
    OR v->'schemaVersion' IS DISTINCT FROM '1'::jsonb
    OR v->>'mode' IS NULL OR v->>'mode' NOT IN ('agent','simulation')
    OR NOT public.qa_text_valid(v->'eventId',36,36) OR NOT public.qa_text_valid(v->'jobId',36,36)
    OR NOT public.qa_text_valid(v->'executionId',36,36)
    OR (v->>'eventId') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
    OR (v->>'jobId') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
    OR (v->>'executionId') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
    OR pg_catalog.octet_length(v::text) > 65536 THEN
    RAISE EXCEPTION 'INVALID_CALLBACK' USING ERRCODE = 'PT400';
  END IF;
  IF v->>'eventType' = 'running' AND v->'sequence' = '1'::jsonb AND v->'result' = 'null'::jsonb AND v->'error' = 'null'::jsonb THEN
    RETURN;
  END IF;
  IF v->'sequence' IS DISTINCT FROM '2'::jsonb THEN
    RAISE EXCEPTION 'INVALID_CALLBACK' USING ERRCODE = 'PT400';
  END IF;
  IF v->>'eventType' = 'failed' AND v->'result' = 'null'::jsonb THEN
    IF pg_catalog.jsonb_typeof(v->'error') IS DISTINCT FROM 'object'
      OR NOT ((v->'error') ?& ARRAY['code','message'])
      OR (v->'error') - ARRAY['code','message'] <> '{}'::jsonb
      OR NOT public.qa_text_valid(v->'error'->'code',1,100)
      OR NOT public.qa_text_valid(v->'error'->'message',1,1000) THEN
      RAISE EXCEPTION 'INVALID_CALLBACK' USING ERRCODE = 'PT400';
    END IF;
    RETURN;
  END IF;
  IF v->>'eventType' IS DISTINCT FROM 'succeeded' OR v->'error' IS DISTINCT FROM 'null'::jsonb THEN
    RAISE EXCEPTION 'INVALID_CALLBACK' USING ERRCODE = 'PT400';
  END IF;
  r := v->'result';
  IF pg_catalog.jsonb_typeof(r) IS DISTINCT FROM 'object' OR NOT (r ?& ARRAY['summary','checks','findings'])
    OR r - ARRAY['summary','checks','findings'] <> '{}'::jsonb OR NOT public.qa_text_valid(r->'summary',1,2000)
    OR pg_catalog.jsonb_typeof(r->'checks') IS DISTINCT FROM 'array' OR pg_catalog.jsonb_typeof(r->'findings') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'INVALID_CALLBACK' USING ERRCODE = 'PT400';
  END IF;
  IF pg_catalog.jsonb_array_length(r->'checks') <> criterion_count OR criterion_count NOT BETWEEN 1 AND 10
    OR pg_catalog.jsonb_array_length(r->'findings') > 20 THEN
    RAISE EXCEPTION 'INVALID_CHECKS' USING ERRCODE = 'PT400';
  END IF;
  FOR c IN SELECT value FROM pg_catalog.jsonb_array_elements(r->'checks') LOOP
    IF pg_catalog.jsonb_typeof(c) IS DISTINCT FROM 'object'
      OR NOT (c ?& ARRAY['criterionIndex','outcome','note']) OR c - ARRAY['criterionIndex','outcome','note'] <> '{}'::jsonb
      OR c->'criterionIndex' IS NULL OR pg_catalog.jsonb_typeof(c->'criterionIndex') IS DISTINCT FROM 'number'
      OR (c->>'criterionIndex') !~ '^[0-9]$'
      OR c->>'outcome' IS NULL OR c->>'outcome' NOT IN ('pass','fail','blocked')
      OR pg_catalog.jsonb_typeof(c->'note') IS DISTINCT FROM 'string' OR pg_catalog.char_length(c->>'note') > 1000 THEN
      RAISE EXCEPTION 'INVALID_CHECKS' USING ERRCODE = 'PT400';
    END IF;
    i := (c->>'criterionIndex')::integer;
    IF i >= criterion_count OR i = ANY(indexes) THEN
      RAISE EXCEPTION 'INVALID_CHECKS' USING ERRCODE = 'PT400';
    END IF;
    indexes := pg_catalog.array_append(indexes, i);
  END LOOP;
  FOR f IN SELECT value FROM pg_catalog.jsonb_array_elements(r->'findings') LOOP
    IF pg_catalog.jsonb_typeof(f) IS DISTINCT FROM 'object'
      OR NOT (f ?& ARRAY['title','steps','expected','actual']) OR f - ARRAY['title','steps','expected','actual'] <> '{}'::jsonb
      OR NOT public.qa_text_valid(f->'title',1,200) OR NOT public.qa_text_valid(f->'steps',1,2000)
      OR NOT public.qa_text_valid(f->'expected',1,1000) OR NOT public.qa_text_valid(f->'actual',1,1000) THEN
      RAISE EXCEPTION 'INVALID_CALLBACK' USING ERRCODE = 'PT400';
    END IF;
  END LOOP;
END; $$;

CREATE FUNCTION public.qa_claim_webhook_dispatch(
  p_job_id uuid,
  p_callback_token_hash text,
  p_retry boolean DEFAULT false,
  p_reconcile boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  u uuid := public.qa_actor();
  j public.qa_jobs;
  now_db timestamptz := pg_catalog.clock_timestamp();
  a uuid := pg_catalog.gen_random_uuid();
  reconcile boolean;
  expired boolean;
BEGIN
  IF p_job_id IS NULL OR p_retry IS NULL OR p_reconcile IS NULL OR (p_retry AND p_reconcile)
    OR p_callback_token_hash IS NULL OR p_callback_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE = 'PT400';
  END IF;
  SELECT * INTO j FROM public.qa_jobs WHERE job_id = p_job_id AND owner_id = u FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'JOB_NOT_FOUND' USING ERRCODE = 'PT404';
  END IF;
  now_db := pg_catalog.clock_timestamp();
  IF j.active_attempt_id IS NOT NULL AND j.lease_expires_at > now_db THEN
    RAISE EXCEPTION 'DISPATCH_IN_PROGRESS' USING ERRCODE = 'PT409';
  END IF;
  IF j.execution_status IN ('succeeded','failed') THEN
    RAISE EXCEPTION 'TERMINAL_JOB' USING ERRCODE = 'PT409';
  END IF;
  expired := j.active_attempt_id IS NOT NULL;
  IF NOT ((p_reconcile AND (j.delivery_status IN ('unknown','accepted') OR (j.delivery_status = 'sending' AND expired)))
    OR (p_retry AND (j.delivery_status IN ('failed','unknown') OR expired))
    OR (NOT p_retry AND NOT p_reconcile AND j.delivery_status = 'not_sent')) THEN
    RAISE EXCEPTION 'ACTION_NOT_ALLOWED' USING ERRCODE = 'PT409';
  END IF;
  reconcile := p_reconcile OR expired OR j.delivery_status IN ('unknown','accepted');
  IF expired THEN
    UPDATE public.qa_dispatch_attempts SET outcome = 'unknown', finished_at = now_db,
      error = '{"code":"LEASE_EXPIRED","message":"Permintaan terhenti; rekonsiliasi diperlukan."}'::jsonb
      WHERE attempt_id = j.active_attempt_id AND owner_id = u AND outcome = 'sending';
  END IF;
  INSERT INTO public.qa_dispatch_attempts(attempt_id, owner_id, job_id, execution_id)
    VALUES (a, u, j.job_id, j.execution_id);
  UPDATE public.qa_jobs SET
    active_attempt_id = a,
    lease_expires_at = now_db + interval '30 seconds',
    callback_token_hash = p_callback_token_hash,
    delivery_status = CASE WHEN last_sequence > 0 THEN 'accepted' WHEN reconcile THEN 'unknown' ELSE 'sending' END,
    version = version + 1,
    updated_at = now_db
    WHERE owner_id = u AND job_id = j.job_id
    RETURNING * INTO j;
  RETURN pg_catalog.jsonb_build_object('job', public.qa_job_dto(j), 'attemptId', a, 'requiresReconciliation', reconcile);
END; $$;

CREATE FUNCTION public.qa_record_webhook_outcome(
  p_job_id uuid,
  p_attempt_id uuid,
  p_outcome text,
  p_error_code text DEFAULT NULL,
  p_error_message text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  u uuid := public.qa_actor();
  j public.qa_jobs;
  e jsonb;
  v_code text;
  v_msg text;
  now_db timestamptz;
BEGIN
  IF p_job_id IS NULL OR p_attempt_id IS NULL OR p_outcome IS NULL OR p_outcome NOT IN ('accepted','rejected','unknown') THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE = 'PT400';
  END IF;
  IF p_outcome = 'accepted' THEN
    e := NULL;
  ELSIF p_outcome = 'rejected' THEN
    v_code := COALESCE(p_error_code, 'WEBHOOK_REJECTED');
    v_msg := COALESCE(p_error_message, 'Webhook QA menolak pengiriman job; periksa konfigurasi lalu coba Retry.');
    IF NOT public.qa_text_valid(pg_catalog.to_jsonb(v_code), 1, 100)
      OR NOT public.qa_text_valid(pg_catalog.to_jsonb(v_msg), 1, 1000) THEN
      RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE = 'PT400';
    END IF;
    e := pg_catalog.jsonb_build_object('code', v_code, 'message', v_msg);
  ELSE
    v_code := COALESCE(p_error_code, 'DELIVERY_UNKNOWN');
    v_msg := COALESCE(p_error_message, 'Outcome pengiriman webhook belum diketahui; lakukan rekonsiliasi.');
    IF NOT public.qa_text_valid(pg_catalog.to_jsonb(v_code), 1, 100)
      OR NOT public.qa_text_valid(pg_catalog.to_jsonb(v_msg), 1, 1000) THEN
      RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE = 'PT400';
    END IF;
    e := pg_catalog.jsonb_build_object('code', v_code, 'message', v_msg);
  END IF;

  SELECT * INTO j FROM public.qa_jobs WHERE job_id = p_job_id AND owner_id = u FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'JOB_NOT_FOUND' USING ERRCODE = 'PT404';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.qa_dispatch_attempts WHERE owner_id = u AND job_id = j.job_id AND attempt_id = p_attempt_id) THEN
    RAISE EXCEPTION 'ATTEMPT_NOT_FOUND' USING ERRCODE = 'PT404';
  END IF;
  now_db := pg_catalog.clock_timestamp();
  IF j.active_attempt_id IS DISTINCT FROM p_attempt_id OR j.lease_expires_at <= now_db THEN
    RETURN pg_catalog.jsonb_build_object('job', public.qa_job_dto(j), 'applied', false);
  END IF;

  UPDATE public.qa_dispatch_attempts
    SET outcome = p_outcome, error = e, finished_at = now_db
    WHERE owner_id = u AND attempt_id = p_attempt_id;
  UPDATE public.qa_jobs SET
    delivery_status = CASE WHEN last_sequence > 0 THEN 'accepted' WHEN p_outcome = 'rejected' THEN 'failed' ELSE p_outcome END,
    execution_status = CASE WHEN last_sequence > 0 THEN execution_status WHEN p_outcome = 'accepted' THEN 'running' ELSE execution_status END,
    last_error = CASE WHEN last_sequence > 0 THEN last_error ELSE e END,
    active_attempt_id = NULL,
    lease_expires_at = NULL,
    version = version + 1,
    updated_at = now_db
    WHERE owner_id = u AND job_id = j.job_id
    RETURNING * INTO j;
  RETURN pg_catalog.jsonb_build_object('job', public.qa_job_dto(j), 'applied', true);
END; $$;

CREATE FUNCTION public.qa_apply_agent_callback(p_callback_token text, p_event jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  j public.qa_jobs;
  receipt public.qa_agent_callback_receipts;
  fp text;
  v_event_id uuid;
  v_seq smallint;
  applied boolean := false;
  now_db timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF p_callback_token IS NULL OR pg_catalog.char_length(p_callback_token) <> 64 OR p_callback_token !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'UNAUTHORIZED_CALLBACK' USING ERRCODE = 'PT401';
  END IF;

  PERFORM public.qa_validate_agent_callback(
    p_event,
    CASE WHEN pg_catalog.jsonb_typeof(p_event->'result'->'checks') = 'array'
      THEN pg_catalog.jsonb_array_length(p_event->'result'->'checks') ELSE 1 END
  );

  SELECT * INTO j FROM public.qa_jobs WHERE job_id = (p_event->>'jobId')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'JOB_NOT_FOUND' USING ERRCODE = 'PT404';
  END IF;

  IF j.callback_token_hash IS NULL
    OR pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_callback_token, 'UTF8')), 'hex') <> j.callback_token_hash THEN
    RAISE EXCEPTION 'UNAUTHORIZED_CALLBACK' USING ERRCODE = 'PT401';
  END IF;

  IF j.execution_id <> (p_event->>'executionId')::uuid THEN
    RAISE EXCEPTION 'EXECUTION_MISMATCH' USING ERRCODE = 'PT409';
  END IF;

  PERFORM public.qa_validate_agent_callback(p_event, pg_catalog.jsonb_array_length(j.input->'acceptanceCriteria'));

  v_event_id := (p_event->>'eventId')::uuid;
  v_seq := (p_event->>'sequence')::smallint;
  fp := public.qa_fingerprint(p_event);
  now_db := pg_catalog.clock_timestamp();

  SELECT * INTO receipt FROM public.qa_agent_callback_receipts WHERE event_id = v_event_id;
  IF FOUND THEN
    IF receipt.owner_id <> j.owner_id
      OR receipt.job_id <> j.job_id
      OR receipt.execution_id <> j.execution_id
      OR receipt.fingerprint <> fp THEN
      RAISE EXCEPTION 'EVENT_CONFLICT' USING ERRCODE = 'PT409';
    END IF;
    RETURN '{"accepted":true,"duplicate":true,"applied":false}'::jsonb;
  END IF;

  IF j.execution_status IN ('succeeded','failed') THEN
    IF v_seq = 2 AND (
      p_event->>'eventType' IS DISTINCT FROM j.execution_status
      OR p_event->'result' IS DISTINCT FROM COALESCE(j.result, 'null'::jsonb)
      OR p_event->'error' IS DISTINCT FROM COALESCE(j.last_error, 'null'::jsonb)
    ) THEN
      RAISE EXCEPTION 'TERMINAL_CONFLICT' USING ERRCODE = 'PT409';
    END IF;
  ELSIF v_seq > j.last_sequence THEN
    IF v_seq = 2 THEN
      IF j.active_attempt_id IS NOT NULL THEN
        UPDATE public.qa_dispatch_attempts
          SET outcome = 'accepted', error = NULL, finished_at = now_db
          WHERE owner_id = j.owner_id AND attempt_id = j.active_attempt_id AND outcome = 'sending';
      END IF;
      UPDATE public.qa_jobs SET
        delivery_status = 'accepted',
        execution_status = p_event->>'eventType',
        result = NULLIF(p_event->'result', 'null'::jsonb),
        last_error = NULLIF(p_event->'error', 'null'::jsonb),
        last_sequence = 2,
        active_attempt_id = NULL,
        lease_expires_at = NULL,
        version = version + 1,
        updated_at = now_db
        WHERE owner_id = j.owner_id AND job_id = j.job_id;
    ELSE
      UPDATE public.qa_jobs SET
        delivery_status = 'accepted',
        execution_status = 'running',
        last_error = NULL,
        last_sequence = 1,
        version = version + 1,
        updated_at = now_db
        WHERE owner_id = j.owner_id AND job_id = j.job_id;
    END IF;
    applied := true;
  END IF;

  INSERT INTO public.qa_agent_callback_receipts(
    event_id, owner_id, job_id, execution_id, sequence, fingerprint, applied, received_at
  ) VALUES (
    v_event_id, j.owner_id, j.job_id, j.execution_id, v_seq, fp, applied, now_db
  );

  RETURN pg_catalog.jsonb_build_object('accepted', true, 'duplicate', false, 'applied', applied);
END; $$;

REVOKE ALL ON FUNCTION public.qa_validate_agent_callback(jsonb, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.qa_claim_webhook_dispatch(uuid, text, boolean, boolean),
  public.qa_record_webhook_outcome(uuid, uuid, text, text, text),
  public.qa_apply_agent_callback(text, jsonb)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.qa_claim_webhook_dispatch(uuid, text, boolean, boolean),
  public.qa_record_webhook_outcome(uuid, uuid, text, text, text)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.qa_apply_agent_callback(text, jsonb)
  TO anon, authenticated;

COMMIT;
