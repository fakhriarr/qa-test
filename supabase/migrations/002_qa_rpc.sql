-- Each RPC is a database transaction. Never replace it with multiple SDK writes.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE FUNCTION public.qa_actor() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE = 'PT401'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.qa_members m WHERE m.user_id = v_uid AND m.active) THEN
    RAISE EXCEPTION 'MEMBERSHIP_REQUIRED' USING ERRCODE = 'PT403';
  END IF;
  RETURN v_uid;
END; $$;

CREATE FUNCTION public.qa_text_valid(v jsonb, lo integer, hi integer) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT COALESCE(pg_catalog.jsonb_typeof(v) = 'string'
    AND pg_catalog.char_length(v #>> '{}') BETWEEN lo AND hi
    AND (v #>> '{}') ~ '[^[:space:]]', false)
$$;
CREATE FUNCTION public.qa_fingerprint(v jsonb) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path = '' AS $$
  SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v::text, 'UTF8')), 'hex')
$$;
CREATE FUNCTION public.qa_validate_input(v jsonb) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE c jsonb; u text;
BEGIN
  IF v IS NULL OR pg_catalog.jsonb_typeof(v) IS DISTINCT FROM 'object'
    OR NOT (v ?& ARRAY['schemaVersion','targetUrl','scope','acceptanceCriteria','deliverables'])
    OR v - ARRAY['schemaVersion','targetUrl','scope','acceptanceCriteria','deliverables'] <> '{}'::jsonb
    OR v->'schemaVersion' IS DISTINCT FROM '1'::jsonb
    OR NOT public.qa_text_valid(v->'targetUrl',1,2048)
    OR NOT public.qa_text_valid(v->'scope',1,2000)
    OR pg_catalog.octet_length(v::text) > 65536 THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE = 'PT400';
  END IF;
  u := v->>'targetUrl';
  -- Conservative HTTP(S) authority grammar shared with TS; no userinfo or whitespace.
  IF u !~ '^https?://(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?)(:[0-9]{1,5})?([/?#][^[:space:]]*)?$'
    OR u ~ '[[:space:]]' THEN RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE = 'PT400'; END IF;
  IF pg_catalog.jsonb_typeof(v->'acceptanceCriteria') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE = 'PT400'; END IF;
  IF pg_catalog.jsonb_array_length(v->'acceptanceCriteria') NOT BETWEEN 1 AND 10 THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE = 'PT400'; END IF;
  FOR c IN SELECT value FROM pg_catalog.jsonb_array_elements(v->'acceptanceCriteria') LOOP
    IF NOT public.qa_text_valid(c,1,500) THEN RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE = 'PT400'; END IF;
  END LOOP;
  IF pg_catalog.jsonb_typeof(v->'deliverables') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE = 'PT400'; END IF;
  IF pg_catalog.jsonb_array_length(v->'deliverables') <> 3
    OR NOT (v->'deliverables' @> '["summary","checks","findings"]'::jsonb) THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE = 'PT400'; END IF;
END; $$;

CREATE FUNCTION public.qa_validate_callback(v jsonb, criterion_count integer) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE r jsonb; c jsonb; f jsonb; indexes integer[] := '{}'; i integer;
BEGIN
  IF v IS NULL OR pg_catalog.jsonb_typeof(v) IS DISTINCT FROM 'object'
    OR NOT (v ?& ARRAY['schemaVersion','mode','eventId','jobId','executionId','sequence','eventType','result','error'])
    OR v - ARRAY['schemaVersion','mode','eventId','jobId','executionId','sequence','eventType','result','error'] <> '{}'::jsonb
    OR v->'schemaVersion' IS DISTINCT FROM '1'::jsonb OR v->>'mode' IS DISTINCT FROM 'simulation'
    OR NOT public.qa_text_valid(v->'eventId',36,36) OR NOT public.qa_text_valid(v->'jobId',36,36)
    OR NOT public.qa_text_valid(v->'executionId',36,36)
    OR (v->>'eventId') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
    OR (v->>'jobId') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
    OR (v->>'executionId') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
    OR pg_catalog.octet_length(v::text) > 65536 THEN
    RAISE EXCEPTION 'INVALID_CALLBACK' USING ERRCODE = 'PT400'; END IF;
  IF v->>'eventType' = 'running' AND v->'sequence' = '1'::jsonb AND v->'result' = 'null'::jsonb AND v->'error' = 'null'::jsonb THEN RETURN; END IF;
  IF v->'sequence' IS DISTINCT FROM '2'::jsonb THEN RAISE EXCEPTION 'INVALID_CALLBACK' USING ERRCODE = 'PT400'; END IF;
  IF v->>'eventType' = 'failed' AND v->'result' = 'null'::jsonb THEN
    IF pg_catalog.jsonb_typeof(v->'error') IS DISTINCT FROM 'object'
      OR NOT ((v->'error') ?& ARRAY['code','message'])
      OR (v->'error') - ARRAY['code','message'] <> '{}'::jsonb
      OR NOT public.qa_text_valid(v->'error'->'code',1,100)
      OR NOT public.qa_text_valid(v->'error'->'message',1,1000) THEN
      RAISE EXCEPTION 'INVALID_CALLBACK' USING ERRCODE = 'PT400'; END IF;
    RETURN;
  END IF;
  IF v->>'eventType' IS DISTINCT FROM 'succeeded' OR v->'error' IS DISTINCT FROM 'null'::jsonb THEN
    RAISE EXCEPTION 'INVALID_CALLBACK' USING ERRCODE = 'PT400'; END IF;
  r := v->'result';
  IF pg_catalog.jsonb_typeof(r) IS DISTINCT FROM 'object' OR NOT (r ?& ARRAY['summary','checks','findings'])
    OR r - ARRAY['summary','checks','findings'] <> '{}'::jsonb OR NOT public.qa_text_valid(r->'summary',1,2000)
    OR pg_catalog.jsonb_typeof(r->'checks') IS DISTINCT FROM 'array' OR pg_catalog.jsonb_typeof(r->'findings') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'INVALID_CALLBACK' USING ERRCODE = 'PT400'; END IF;
  IF pg_catalog.jsonb_array_length(r->'checks') <> criterion_count OR criterion_count NOT BETWEEN 1 AND 10
    OR pg_catalog.jsonb_array_length(r->'findings') > 20 THEN
    RAISE EXCEPTION 'INVALID_CHECKS' USING ERRCODE = 'PT400'; END IF;
  FOR c IN SELECT value FROM pg_catalog.jsonb_array_elements(r->'checks') LOOP
    IF pg_catalog.jsonb_typeof(c) IS DISTINCT FROM 'object'
      OR NOT (c ?& ARRAY['criterionIndex','outcome','note']) OR c - ARRAY['criterionIndex','outcome','note'] <> '{}'::jsonb
      OR c->'criterionIndex' IS NULL OR pg_catalog.jsonb_typeof(c->'criterionIndex') IS DISTINCT FROM 'number'
      OR (c->>'criterionIndex') !~ '^[0-9]$'
      OR c->>'outcome' IS NULL OR c->>'outcome' NOT IN ('pass','fail','blocked')
      OR pg_catalog.jsonb_typeof(c->'note') IS DISTINCT FROM 'string' OR pg_catalog.char_length(c->>'note') > 1000 THEN
      RAISE EXCEPTION 'INVALID_CHECKS' USING ERRCODE = 'PT400'; END IF;
    i := (c->>'criterionIndex')::integer;
    IF i >= criterion_count OR i = ANY(indexes) THEN RAISE EXCEPTION 'INVALID_CHECKS' USING ERRCODE = 'PT400'; END IF;
    indexes := pg_catalog.array_append(indexes,i);
  END LOOP;
  FOR f IN SELECT value FROM pg_catalog.jsonb_array_elements(r->'findings') LOOP
    IF pg_catalog.jsonb_typeof(f) IS DISTINCT FROM 'object'
      OR NOT (f ?& ARRAY['title','steps','expected','actual']) OR f - ARRAY['title','steps','expected','actual'] <> '{}'::jsonb
      OR NOT public.qa_text_valid(f->'title',1,200) OR NOT public.qa_text_valid(f->'steps',1,2000)
      OR NOT public.qa_text_valid(f->'expected',1,1000) OR NOT public.qa_text_valid(f->'actual',1,1000) THEN
      RAISE EXCEPTION 'INVALID_CALLBACK' USING ERRCODE = 'PT400'; END IF;
  END LOOP;
END; $$;

CREATE FUNCTION public.qa_job_dto(j public.qa_jobs) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT j.input || pg_catalog.jsonb_build_object(
    'jobId',j.job_id,'executionId',j.execution_id,'mode','simulation','createdAt',j.created_at,
    'updatedAt',j.updated_at,'version',j.version,'deliveryStatus',j.delivery_status,
    'executionStatus',j.execution_status,'lastError',j.last_error,'result',j.result,'leaseExpiresAt',j.lease_expires_at)
$$;

CREATE FUNCTION public.qa_create_job(p_key uuid, p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE u uuid := public.qa_actor(); j public.qa_jobs; k public.qa_create_keys; fp text;
BEGIN
  IF p_key IS NULL OR p_key::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE = 'PT400'; END IF;
  PERFORM public.qa_validate_input(p_input);
  fp := public.qa_fingerprint(p_input);
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(u::text || ':POST /jobs:' || p_key::text,0));
  SELECT * INTO k FROM public.qa_create_keys WHERE owner_id = u AND operation = 'POST /jobs' AND key = p_key;
  IF FOUND THEN
    IF k.fingerprint <> fp THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE = 'PT409'; END IF;
    SELECT * INTO j FROM public.qa_jobs WHERE owner_id = u AND job_id = k.job_id;
    RETURN pg_catalog.jsonb_build_object('job',public.qa_job_dto(j),'replay',true);
  END IF;
  INSERT INTO public.qa_jobs(owner_id,input) VALUES(u,p_input) RETURNING * INTO j;
  INSERT INTO public.qa_create_keys(owner_id,operation,key,fingerprint,job_id) VALUES(u,'POST /jobs',p_key,fp,j.job_id);
  RETURN pg_catalog.jsonb_build_object('job',public.qa_job_dto(j),'replay',false);
END; $$;

CREATE FUNCTION public.qa_claim_dispatch(p_job_id uuid, p_retry boolean DEFAULT false, p_reconcile boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE u uuid := public.qa_actor(); j public.qa_jobs; now_db timestamptz := pg_catalog.clock_timestamp();
  a uuid := pg_catalog.gen_random_uuid(); reconcile boolean; expired boolean;
BEGIN
  IF p_retry IS NULL OR p_reconcile IS NULL OR (p_retry AND p_reconcile) THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE = 'PT400'; END IF;
  SELECT * INTO j FROM public.qa_jobs WHERE job_id = p_job_id AND owner_id = u FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'JOB_NOT_FOUND' USING ERRCODE = 'PT404'; END IF;
  now_db := pg_catalog.clock_timestamp();
  IF j.active_attempt_id IS NOT NULL AND j.lease_expires_at > now_db THEN
    RAISE EXCEPTION 'DISPATCH_IN_PROGRESS' USING ERRCODE = 'PT409'; END IF;
  IF j.execution_status IN ('succeeded','failed') THEN RAISE EXCEPTION 'TERMINAL_JOB' USING ERRCODE = 'PT409'; END IF;
  expired := j.active_attempt_id IS NOT NULL;
  IF NOT ((p_reconcile AND (j.delivery_status IN ('unknown','accepted') OR (j.delivery_status = 'sending' AND expired)))
    OR (p_retry AND (j.delivery_status IN ('failed','unknown') OR expired))
    OR (NOT p_retry AND NOT p_reconcile AND j.delivery_status = 'not_sent')) THEN
    RAISE EXCEPTION 'ACTION_NOT_ALLOWED' USING ERRCODE = 'PT409'; END IF;
  reconcile := p_reconcile OR expired OR j.delivery_status IN ('unknown','accepted');
  IF expired THEN
    UPDATE public.qa_dispatch_attempts SET outcome = 'unknown', finished_at = now_db,
      error = '{"code":"LEASE_EXPIRED","message":"Permintaan terhenti; rekonsiliasi diperlukan."}'::jsonb
      WHERE attempt_id = j.active_attempt_id AND owner_id = u AND outcome = 'sending';
  END IF;
  INSERT INTO public.qa_dispatch_attempts(attempt_id,owner_id,job_id,execution_id) VALUES(a,u,j.job_id,j.execution_id);
  UPDATE public.qa_jobs SET active_attempt_id = a, lease_expires_at = now_db + interval '30 seconds',
    delivery_status = CASE WHEN last_sequence > 0 THEN 'accepted' WHEN reconcile THEN 'unknown' ELSE 'sending' END,
    version = version + 1, updated_at = now_db WHERE owner_id = u AND job_id = j.job_id RETURNING * INTO j;
  RETURN pg_catalog.jsonb_build_object('job',public.qa_job_dto(j),'attemptId',a,'requiresReconciliation',reconcile);
END; $$;

CREATE FUNCTION public.qa_record_outcome(p_job_id uuid, p_attempt_id uuid, p_outcome text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE u uuid := public.qa_actor(); j public.qa_jobs; e jsonb; now_db timestamptz;
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('accepted','rejected','unknown') THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE = 'PT400'; END IF;
  SELECT * INTO j FROM public.qa_jobs WHERE job_id = p_job_id AND owner_id = u FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'JOB_NOT_FOUND' USING ERRCODE = 'PT404'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.qa_dispatch_attempts WHERE owner_id = u AND job_id = j.job_id AND attempt_id = p_attempt_id) THEN
    RAISE EXCEPTION 'ATTEMPT_NOT_FOUND' USING ERRCODE = 'PT404'; END IF;
  now_db := pg_catalog.clock_timestamp();
  -- Fencing applies even if no newer request has claimed yet. An expired response is not authoritative.
  IF j.active_attempt_id IS DISTINCT FROM p_attempt_id OR j.lease_expires_at <= now_db THEN
    RETURN pg_catalog.jsonb_build_object('job',public.qa_job_dto(j),'applied',false);
  END IF;
  e := CASE p_outcome WHEN 'rejected' THEN '{"code":"SIMULATED_REJECTION","message":"Simulator belum menerima job; retry dapat dilakukan."}'::jsonb
    WHEN 'unknown' THEN '{"code":"DELIVERY_UNKNOWN","message":"Outcome belum diketahui; lakukan rekonsiliasi."}'::jsonb ELSE NULL END;
  UPDATE public.qa_dispatch_attempts SET outcome = p_outcome,error = e,finished_at = now_db WHERE owner_id = u AND attempt_id = p_attempt_id;
  UPDATE public.qa_jobs SET
    delivery_status = CASE WHEN last_sequence > 0 THEN 'accepted' WHEN p_outcome = 'rejected' THEN 'failed' ELSE p_outcome END,
    execution_status = CASE WHEN last_sequence > 0 THEN execution_status WHEN p_outcome = 'accepted' THEN 'running' ELSE execution_status END,
    last_error = CASE WHEN last_sequence > 0 THEN last_error ELSE e END,
    active_attempt_id = NULL, lease_expires_at = NULL, version = version + 1, updated_at = now_db
    WHERE owner_id = u AND job_id = j.job_id RETURNING * INTO j;
  RETURN pg_catalog.jsonb_build_object('job',public.qa_job_dto(j),'applied',true);
END; $$;

CREATE FUNCTION public.qa_sim_accept(p_job_id uuid, p_execution_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE u uuid := public.qa_actor(); j public.qa_jobs; e jsonb; fp text; inbox public.qa_simulator_inbox;
BEGIN
  SELECT * INTO j FROM public.qa_jobs WHERE job_id = p_job_id AND owner_id = u FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'JOB_NOT_FOUND' USING ERRCODE = 'PT404'; END IF;
  IF j.execution_id <> p_execution_id OR p_execution_id IS NULL THEN RAISE EXCEPTION 'EXECUTION_MISMATCH' USING ERRCODE = 'PT409'; END IF;
  e := j.input || pg_catalog.jsonb_build_object('schemaVersion',1,'mode','simulation','jobId',j.job_id,'executionId',j.execution_id);
  fp := public.qa_fingerprint(e);
  SELECT * INTO inbox FROM public.qa_simulator_inbox WHERE execution_id = j.execution_id AND owner_id = u;
  IF FOUND THEN
    IF inbox.fingerprint <> fp OR inbox.envelope <> e THEN RAISE EXCEPTION 'RECEIVER_CONFLICT' USING ERRCODE = 'PT409'; END IF;
  ELSE
    IF j.active_attempt_id IS NULL OR j.lease_expires_at <= pg_catalog.clock_timestamp() THEN
      RAISE EXCEPTION 'DISPATCH_REQUIRED' USING ERRCODE = 'PT409'; END IF;
    INSERT INTO public.qa_simulator_inbox(execution_id,owner_id,job_id,fingerprint,envelope) VALUES(j.execution_id,u,j.job_id,fp,e);
  END IF;
  RETURN pg_catalog.jsonb_build_object('kind','accepted','executionId',j.execution_id);
END; $$;

CREATE FUNCTION public.qa_sim_complete(p_execution_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE u uuid := public.qa_actor(); inbox public.qa_simulator_inbox; j public.qa_jobs;
  r jsonb; checks jsonb; event uuid; body jsonb; seq smallint;
BEGIN
  SELECT * INTO inbox FROM public.qa_simulator_inbox WHERE owner_id = u AND execution_id = p_execution_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'EXECUTION_NOT_FOUND' USING ERRCODE = 'PT404'; END IF;
  SELECT * INTO j FROM public.qa_jobs WHERE owner_id = u AND job_id = inbox.job_id FOR UPDATE;
  SELECT * INTO inbox FROM public.qa_simulator_inbox WHERE owner_id = u AND execution_id = p_execution_id FOR UPDATE;
  IF inbox.state = 'terminal' THEN RETURN; END IF;
  SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('criterionIndex',ordinality - 1,'outcome','pass',
    'note','Hasil dummy simulator; bukan penilaian website.') ORDER BY ordinality) INTO checks
    FROM pg_catalog.jsonb_array_elements(j.input->'acceptanceCriteria') WITH ORDINALITY;
  r := pg_catalog.jsonb_build_object('summary','SIMULASI AGENT — bukan integrasi QA OpenBot; penyimpanan Supabase. Target URL tidak dikunjungi.',
    'checks',checks,'findings','[]'::jsonb);
  UPDATE public.qa_simulator_inbox SET state = 'terminal',logical_execution_count = 1,result = r WHERE owner_id = u AND execution_id = p_execution_id AND state = 'pending';
  FOR seq IN 1..2 LOOP
    event := pg_catalog.gen_random_uuid();
    body := pg_catalog.jsonb_build_object('schemaVersion',1,'mode','simulation','eventId',event,'jobId',j.job_id,
      'executionId',j.execution_id,'sequence',seq,'eventType',CASE seq WHEN 1 THEN 'running' ELSE 'succeeded' END,
      'result',CASE WHEN seq = 2 THEN r ELSE NULL END,'error',NULL);
    PERFORM public.qa_validate_callback(body,pg_catalog.jsonb_array_length(j.input->'acceptanceCriteria'));
    INSERT INTO public.qa_simulator_outbox(event_id,owner_id,job_id,execution_id,sequence,body) VALUES(event,u,j.job_id,j.execution_id,seq,body);
  END LOOP;
END; $$;

CREATE FUNCTION public.qa_apply_sim_callback(p_event jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE u uuid := public.qa_actor(); j public.qa_jobs; stored public.qa_simulator_outbox;
  receipt public.qa_callback_receipts; fp text; applied boolean := false; event uuid;
BEGIN
  -- Validate before casting any untrusted IDs; coverage validated again against the owned job.
  PERFORM public.qa_validate_callback(p_event,CASE WHEN pg_catalog.jsonb_typeof(p_event->'result'->'checks') = 'array'
    THEN pg_catalog.jsonb_array_length(p_event->'result'->'checks') ELSE 1 END);
  SELECT * INTO j FROM public.qa_jobs WHERE owner_id = u AND job_id = (p_event->>'jobId')::uuid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'JOB_NOT_FOUND' USING ERRCODE = 'PT404'; END IF;
  IF j.execution_id <> (p_event->>'executionId')::uuid THEN RAISE EXCEPTION 'EXECUTION_MISMATCH' USING ERRCODE = 'PT409'; END IF;
  PERFORM public.qa_validate_callback(p_event,pg_catalog.jsonb_array_length(j.input->'acceptanceCriteria'));
  event := (p_event->>'eventId')::uuid; fp := public.qa_fingerprint(p_event);
  SELECT * INTO receipt FROM public.qa_callback_receipts WHERE event_id = event;
  IF FOUND THEN
    IF receipt.owner_id <> u OR receipt.fingerprint <> fp THEN RAISE EXCEPTION 'EVENT_CONFLICT' USING ERRCODE = 'PT409'; END IF;
    RETURN '{"accepted":true,"duplicate":true,"applied":false}'::jsonb;
  END IF;
  SELECT * INTO stored FROM public.qa_simulator_outbox WHERE event_id = event AND owner_id = u AND job_id = j.job_id AND execution_id = j.execution_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'EVENT_NOT_FOUND' USING ERRCODE = 'PT404'; END IF;
  IF stored.body <> p_event THEN RAISE EXCEPTION 'EVENT_CONFLICT' USING ERRCODE = 'PT409'; END IF;
  IF j.execution_status IN ('succeeded','failed') THEN
    IF p_event->'sequence' = '2'::jsonb AND
      (p_event->>'eventType' IS DISTINCT FROM j.execution_status
       OR p_event->'result' IS DISTINCT FROM COALESCE(j.result,'null'::jsonb)
       OR p_event->'error' IS DISTINCT FROM COALESCE(j.last_error,'null'::jsonb)) THEN
      RAISE EXCEPTION 'TERMINAL_CONFLICT' USING ERRCODE = 'PT409'; END IF;
  ELSIF (p_event->>'sequence')::smallint > j.last_sequence THEN
    UPDATE public.qa_jobs SET delivery_status = 'accepted', execution_status = p_event->>'eventType',
      result = NULLIF(p_event->'result','null'::jsonb), last_error = NULLIF(p_event->'error','null'::jsonb),
      last_sequence = (p_event->>'sequence')::smallint, version = version + 1, updated_at = pg_catalog.clock_timestamp()
      WHERE owner_id = u AND job_id = j.job_id;
    applied := true;
  END IF;
  INSERT INTO public.qa_callback_receipts(event_id,owner_id,job_id,execution_id,fingerprint,applied) VALUES(event,u,j.job_id,j.execution_id,fp,applied);
  RETURN pg_catalog.jsonb_build_object('accepted',true,'duplicate',false,'applied',applied);
END; $$;

CREATE FUNCTION public.qa_mark_outbox_delivered(p_event_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE u uuid := public.qa_actor(); e public.qa_simulator_outbox;
BEGIN
  SELECT * INTO e FROM public.qa_simulator_outbox WHERE event_id = p_event_id AND owner_id = u FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'EVENT_NOT_FOUND' USING ERRCODE = 'PT404'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.qa_callback_receipts WHERE owner_id = u AND event_id = e.event_id AND job_id = e.job_id AND execution_id = e.execution_id) THEN
    RAISE EXCEPTION 'RECEIPT_REQUIRED' USING ERRCODE = 'PT409'; END IF;
  UPDATE public.qa_simulator_outbox SET delivered = true WHERE event_id = e.event_id AND owner_id = u;
END; $$;

-- Helpers are private, including the membership/DTO/validation helpers. Definers run as migration owner.
REVOKE ALL ON FUNCTION public.qa_actor(), public.qa_text_valid(jsonb,integer,integer), public.qa_fingerprint(jsonb),
  public.qa_validate_input(jsonb), public.qa_validate_callback(jsonb,integer), public.qa_job_dto(public.qa_jobs)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.qa_create_job(uuid,jsonb), public.qa_claim_dispatch(uuid,boolean,boolean),
  public.qa_record_outcome(uuid,uuid,text), public.qa_sim_accept(uuid,uuid), public.qa_sim_complete(uuid),
  public.qa_apply_sim_callback(jsonb), public.qa_mark_outbox_delivered(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.qa_create_job(uuid,jsonb), public.qa_claim_dispatch(uuid,boolean,boolean),
  public.qa_record_outcome(uuid,uuid,text), public.qa_sim_accept(uuid,uuid), public.qa_sim_complete(uuid),
  public.qa_apply_sim_callback(jsonb), public.qa_mark_outbox_delivered(uuid) TO authenticated;
COMMIT;
