-- Review before applying once in Supabase SQL Editor; no existing objects are replaced.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE public.qa_members (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id),
  active boolean NOT NULL DEFAULT true
);
CREATE TABLE public.qa_jobs (
  job_id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  execution_id uuid NOT NULL UNIQUE DEFAULT pg_catalog.gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES auth.users(id),
  input jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(input) = 'object' AND (input->'schemaVersion' IS NOT DISTINCT FROM '1'::jsonb)),
  result jsonb CHECK (result IS NULL OR pg_catalog.jsonb_typeof(result) = 'object'),
  last_error jsonb CHECK (last_error IS NULL OR pg_catalog.jsonb_typeof(last_error) = 'object'),
  delivery_status text NOT NULL DEFAULT 'not_sent' CHECK (delivery_status IN ('not_sent','sending','accepted','failed','unknown')),
  execution_status text NOT NULL DEFAULT 'not_started' CHECK (execution_status IN ('not_started','running','succeeded','failed')),
  last_sequence smallint NOT NULL DEFAULT 0 CHECK (last_sequence BETWEEN 0 AND 2),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  active_attempt_id uuid,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  UNIQUE (owner_id,job_id), UNIQUE (owner_id,job_id,execution_id),
  CHECK ((active_attempt_id IS NULL) = (lease_expires_at IS NULL)),
  CHECK ((execution_status = 'succeeded' AND result IS NOT NULL AND last_error IS NULL AND last_sequence = 2)
      OR (execution_status = 'failed' AND result IS NULL AND last_error IS NOT NULL AND last_sequence = 2)
      OR (execution_status IN ('not_started','running') AND result IS NULL AND last_sequence < 2))
);
CREATE INDEX qa_jobs_latest ON public.qa_jobs(owner_id,created_at DESC,job_id DESC);
CREATE TABLE public.qa_create_keys (
  owner_id uuid NOT NULL, operation text NOT NULL CHECK (operation = 'POST /jobs'),
  key uuid NOT NULL, fingerprint text NOT NULL CHECK (pg_catalog.length(fingerprint) = 64),
  job_id uuid NOT NULL,
  PRIMARY KEY (owner_id,operation,key),
  FOREIGN KEY (owner_id,job_id) REFERENCES public.qa_jobs(owner_id,job_id)
);
CREATE TABLE public.qa_dispatch_attempts (
  attempt_id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  owner_id uuid NOT NULL, job_id uuid NOT NULL, execution_id uuid NOT NULL,
  outcome text NOT NULL DEFAULT 'sending' CHECK (outcome IN ('sending','accepted','rejected','unknown')),
  error jsonb,
  started_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(), finished_at timestamptz,
  UNIQUE (owner_id,job_id,execution_id,attempt_id),
  FOREIGN KEY (owner_id,job_id,execution_id) REFERENCES public.qa_jobs(owner_id,job_id,execution_id)
);
ALTER TABLE public.qa_jobs ADD CONSTRAINT qa_jobs_active_attempt_fk
  FOREIGN KEY (owner_id,job_id,execution_id,active_attempt_id)
  REFERENCES public.qa_dispatch_attempts(owner_id,job_id,execution_id,attempt_id);
CREATE TABLE public.qa_simulator_inbox (
  execution_id uuid PRIMARY KEY, owner_id uuid NOT NULL, job_id uuid NOT NULL,
  fingerprint text NOT NULL CHECK (pg_catalog.length(fingerprint) = 64),
  envelope jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(envelope) = 'object'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','terminal')),
  logical_execution_count smallint NOT NULL DEFAULT 0 CHECK (logical_execution_count IN (0,1)),
  result jsonb,
  UNIQUE (owner_id,job_id,execution_id),
  FOREIGN KEY (owner_id,job_id,execution_id) REFERENCES public.qa_jobs(owner_id,job_id,execution_id),
  CHECK ((state = 'pending' AND logical_execution_count = 0 AND result IS NULL)
      OR (state = 'terminal' AND logical_execution_count = 1 AND result IS NOT NULL))
);
CREATE TABLE public.qa_simulator_outbox (
  event_id uuid PRIMARY KEY, owner_id uuid NOT NULL, job_id uuid NOT NULL, execution_id uuid NOT NULL,
  sequence smallint NOT NULL CHECK (sequence IN (1,2)), body jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(body) = 'object'),
  delivered boolean NOT NULL DEFAULT false,
  UNIQUE (execution_id,sequence), UNIQUE (owner_id,job_id,execution_id,event_id),
  FOREIGN KEY (owner_id,job_id,execution_id) REFERENCES public.qa_simulator_inbox(owner_id,job_id,execution_id)
);
CREATE INDEX qa_outbox_pending ON public.qa_simulator_outbox(owner_id,execution_id,delivered);
CREATE TABLE public.qa_callback_receipts (
  event_id uuid PRIMARY KEY, owner_id uuid NOT NULL, job_id uuid NOT NULL, execution_id uuid NOT NULL,
  fingerprint text NOT NULL CHECK (pg_catalog.length(fingerprint) = 64), applied boolean NOT NULL,
  FOREIGN KEY (owner_id,job_id,execution_id) REFERENCES public.qa_jobs(owner_id,job_id,execution_id),
  FOREIGN KEY (owner_id,job_id,execution_id,event_id) REFERENCES public.qa_simulator_outbox(owner_id,job_id,execution_id,event_id)
);

ALTER TABLE public.qa_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.qa_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.qa_create_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.qa_dispatch_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.qa_simulator_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.qa_simulator_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.qa_callback_receipts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.qa_members, public.qa_jobs, public.qa_create_keys,
  public.qa_dispatch_attempts, public.qa_simulator_inbox, public.qa_simulator_outbox,
  public.qa_callback_receipts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.qa_members, public.qa_jobs, public.qa_create_keys,
  public.qa_dispatch_attempts, public.qa_simulator_inbox, public.qa_simulator_outbox,
  public.qa_callback_receipts TO authenticated;
CREATE POLICY qa_members_read_self ON public.qa_members FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));
-- SELECT only. No client write policy/grant; SECURITY DEFINER RPCs validate caller explicitly.
CREATE POLICY qa_jobs_read_owner ON public.qa_jobs FOR SELECT TO authenticated
  USING (owner_id = (SELECT auth.uid()) AND EXISTS (SELECT 1 FROM public.qa_members m WHERE m.user_id = (SELECT auth.uid()) AND m.active));
CREATE POLICY qa_keys_read_owner ON public.qa_create_keys FOR SELECT TO authenticated
  USING (owner_id = (SELECT auth.uid()) AND EXISTS (SELECT 1 FROM public.qa_members m WHERE m.user_id = (SELECT auth.uid()) AND m.active));
CREATE POLICY qa_attempts_read_owner ON public.qa_dispatch_attempts FOR SELECT TO authenticated
  USING (owner_id = (SELECT auth.uid()) AND EXISTS (SELECT 1 FROM public.qa_members m WHERE m.user_id = (SELECT auth.uid()) AND m.active));
CREATE POLICY qa_inbox_read_owner ON public.qa_simulator_inbox FOR SELECT TO authenticated
  USING (owner_id = (SELECT auth.uid()) AND EXISTS (SELECT 1 FROM public.qa_members m WHERE m.user_id = (SELECT auth.uid()) AND m.active));
CREATE POLICY qa_outbox_read_owner ON public.qa_simulator_outbox FOR SELECT TO authenticated
  USING (owner_id = (SELECT auth.uid()) AND EXISTS (SELECT 1 FROM public.qa_members m WHERE m.user_id = (SELECT auth.uid()) AND m.active));
CREATE POLICY qa_receipts_read_owner ON public.qa_callback_receipts FOR SELECT TO authenticated
  USING (owner_id = (SELECT auth.uid()) AND EXISTS (SELECT 1 FROM public.qa_members m WHERE m.user_id = (SELECT auth.uid()) AND m.active));
COMMIT;
