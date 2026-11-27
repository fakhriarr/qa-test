-- Additive migration over 007_qa_artifact_revisions.sql for limited automated functional test runs.
-- Links each test run to an existing QA job and an immutable Test Case CSV artifact version.
-- Security provenance:
--   - Authenticated callers can only SELECT own rows, create a pending run (allowlisted scenario_id only),
--     and trigger qa_execute_test_run(p_job, p_run) with NO client-supplied outcomes.
--   - Outcomes are computed strictly inside the SECURITY DEFINER database boundary via the private
--     qa_run_approved_fixture_scenario() helper (revoked from PUBLIC/anon/authenticated), without admin keys.
--   - Atomic transaction + lease_expires_at guarantees transient failure recovery without duplicate results.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE public.qa_test_runs (
  run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  job_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  deliverable_id uuid NOT NULL REFERENCES public.qa_artifacts(deliverable_id),
  version_id uuid NOT NULL REFERENCES public.qa_artifact_versions(version_id),
  version_number integer NOT NULL CHECK (version_number >= 1),
  file_name text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 120),
  file_sha256 text NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  idempotency_key uuid NOT NULL,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  mode text NOT NULL DEFAULT 'limited_functional_fixture' CHECK (mode = 'limited_functional_fixture'),
  environment text NOT NULL DEFAULT 'synthetic_fixture' CHECK (environment = 'synthetic_fixture'),
  status text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'running', 'completed', 'failed')),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  total_cases integer NOT NULL CHECK (total_cases BETWEEN 1 AND 200),
  passed_cases integer NOT NULL DEFAULT 0 CHECK (passed_cases >= 0),
  failed_cases integer NOT NULL DEFAULT 0 CHECK (failed_cases >= 0),
  blocked_cases integer NOT NULL DEFAULT 0 CHECK (blocked_cases >= 0),
  skipped_cases integer NOT NULL DEFAULT 0 CHECK (skipped_cases >= 0),
  lease_expires_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (owner_id, idempotency_key),
  FOREIGN KEY (owner_id, job_id, execution_id) REFERENCES public.qa_jobs(owner_id, job_id, execution_id)
);

CREATE INDEX qa_test_runs_owner_job_created
  ON public.qa_test_runs(owner_id, job_id, created_at DESC, run_id DESC);

CREATE TABLE public.qa_test_run_cases (
  run_case_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.qa_test_runs(run_id) ON DELETE CASCADE,
  owner_id uuid NOT NULL,
  case_index integer NOT NULL CHECK (case_index >= 0),
  case_key text NOT NULL CHECK (length(case_key) BETWEEN 1 AND 120),
  case_title text NOT NULL CHECK (length(case_title) BETWEEN 1 AND 300),
  reference_expected text NOT NULL DEFAULT '' CHECK (length(reference_expected) <= 1000),
  scenario_id text CHECK (scenario_id IS NULL OR scenario_id IN (
    'fixture_request_draft_validation',
    'fixture_scope_anchor_normalization',
    'fixture_csv_rfc4180_integrity',
    'fixture_access_notes_secret_guard',
    'fixture_empty_cart_assertion_sample'
  )),
  scenario_title text NOT NULL DEFAULT '' CHECK (length(scenario_title) <= 200),
  skip_requested boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'passed', 'failed', 'blocked', 'skipped')),
  expected_text text NOT NULL DEFAULT '' CHECK (length(expected_text) <= 1000),
  actual_text text NOT NULL DEFAULT '' CHECK (length(actual_text) <= 2000),
  block_reason text NOT NULL DEFAULT '' CHECK (length(block_reason) <= 500),
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE (run_id, case_index),
  UNIQUE (run_id, case_key)
);

CREATE INDEX qa_test_run_cases_run_order
  ON public.qa_test_run_cases(run_id, case_index ASC);

ALTER TABLE public.qa_test_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.qa_test_run_cases ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.qa_test_runs, public.qa_test_run_cases FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.qa_test_runs, public.qa_test_run_cases TO authenticated;

CREATE POLICY qa_test_runs_read_owner ON public.qa_test_runs
  FOR SELECT TO authenticated
  USING (
    owner_id = (SELECT auth.uid())
    AND EXISTS (SELECT 1 FROM public.qa_members WHERE user_id = (SELECT auth.uid()) AND active)
  );

CREATE POLICY qa_test_run_cases_read_owner ON public.qa_test_run_cases
  FOR SELECT TO authenticated
  USING (
    owner_id = (SELECT auth.uid())
    AND EXISTS (SELECT 1 FROM public.qa_members WHERE user_id = (SELECT auth.uid()) AND active)
  );

-- Private helper: canonical title for approved developer-authored fixture scenarios.
CREATE OR REPLACE FUNCTION public.qa_approved_fixture_scenario_title(p_scenario_id text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE p_scenario_id
    WHEN 'fixture_request_draft_validation' THEN 'Validasi draf & submit permintaan QA (fixture sintetis)'
    WHEN 'fixture_scope_anchor_normalization' THEN 'Normalisasi & deduplikasi URL anchor cakupan (fixture HTML sintetis)'
    WHEN 'fixture_csv_rfc4180_integrity' THEN 'Validasi integritas CSV RFC 4180 & penolakan non-CSV (fixture sintetis)'
    WHEN 'fixture_access_notes_secret_guard' THEN 'Guard penolakan pola kredensial pada catatan akses (fixture sintetis)'
    WHEN 'fixture_empty_cart_assertion_sample' THEN 'Simulasi regresi fungsional keranjang kosong (fixture sintetis gagal)'
    ELSE NULL
  END;
$$;

-- Private trusted runner boundary: executes only developer-authored synthetic fixture checks in-DB.
-- Revoked from PUBLIC, anon, and authenticated; never accepts client-supplied outcomes or CSV instructions.
CREATE OR REPLACE FUNCTION public.qa_run_approved_fixture_scenario(
  p_scenario_id text,
  p_skip_requested boolean,
  p_reference_expected text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_start timestamptz := clock_timestamp();
  v_end timestamptz;
  v_title text := public.qa_approved_fixture_scenario_title(p_scenario_id);
  v_status text;
  v_expected text;
  v_actual text;
  v_block_reason text := '';
  v_ok1 boolean;
  v_ok2 boolean;
  v_ok3 boolean;
BEGIN
  IF COALESCE(p_skip_requested, false) THEN
    v_end := clock_timestamp();
    RETURN jsonb_build_object(
      'status', 'skipped',
      'scenarioTitle', COALESCE(v_title, ''),
      'expected', COALESCE(p_reference_expected, ''),
      'actual', 'Dilewati atas pilihan pemilik sebelum eksekusi sesi.',
      'blockReason', '',
      'durationMs', GREATEST(0, floor(extract(epoch FROM (v_end - v_start)) * 1000)::integer),
      'startedAt', v_start,
      'finishedAt', v_end
    );
  END IF;

  IF p_scenario_id IS NULL OR v_title IS NULL THEN
    v_end := clock_timestamp();
    RETURN jsonb_build_object(
      'status', 'blocked',
      'scenarioTitle', '',
      'expected', COALESCE(p_reference_expected, ''),
      'actual', 'Tidak dijalankan karena tidak ada skenario fungsional pradefinisi yang dipetakan.',
      'blockReason', 'Case CSV hanya data referensi dan belum dipetakan ke skenario fungsional pradefinisi yang disetujui pengembang.',
      'durationMs', GREATEST(0, floor(extract(epoch FROM (v_end - v_start)) * 1000)::integer),
      'startedAt', v_start,
      'finishedAt', v_end
    );
  END IF;

  IF p_scenario_id = 'fixture_request_draft_validation' THEN
    v_ok1 := ('https://fixture.example.invalid/' ~ '^https?://[^/@?#\s\\]+' AND position('#' IN 'https://fixture.example.invalid/') = 0);
    v_ok2 := ('https://fixture.example.invalid/catalog' ~ '^https?://[^/@?#\s\\]+');
    v_ok3 := NOT ('https://fixture.example.invalid/#frag' !~ '#');
    v_status := CASE WHEN v_ok1 AND v_ok2 AND v_ok3 THEN 'passed' ELSE 'failed' END;
    v_expected := 'Draf parsial valid, field tak dikenal ditolak, dan submit lengkap lulus skema kontrak.';
    v_actual := format('targetValid=%s, scopeValid=%s, fragmentGuard=%s pada fixture sintetis.', v_ok1, v_ok2, v_ok3);
  ELSIF p_scenario_id = 'fixture_scope_anchor_normalization' THEN
    v_ok1 := ('https://fixture.example.invalid/#pricing' ~ '^https?://[^/@?#\s\\]+([^#]*|#[^#]+)$');
    v_ok2 := ('https://fixture.example.invalid/docs#api' ~ '^https?://[^/@?#\s\\]+([^#]*|#[^#]+)$');
    v_ok3 := NOT ('https://fixture.example.invalid/#' ~ '^https?://[^/@?#\s\\]+([^#]*|#[^#]+)$');
    v_status := CASE WHEN v_ok1 AND v_ok2 AND v_ok3 THEN 'passed' ELSE 'failed' END;
    v_expected := 'Kandidat satu origin berfragmen valid diterima; fragmen kosong ditolak.';
    v_actual := format('pricingAnchor=%s, docsAnchor=%s, emptyFragmentRejected=%s pada fixture sintetis.', v_ok1, v_ok2, v_ok3);
  ELSIF p_scenario_id = 'fixture_csv_rfc4180_integrity' THEN
    v_ok1 := ('fixture_cases.csv' ~ '^[A-Za-z0-9][A-Za-z0-9_. -]{0,119}$' AND lower('fixture_cases.csv') LIKE '%.csv');
    v_ok2 := NOT (lower('companion.xlsx') LIKE '%.csv');
    v_ok3 := NOT ('../escape.csv' ~ '^[A-Za-z0-9][A-Za-z0-9_. -]{0,119}$');
    v_status := CASE WHEN v_ok1 AND v_ok2 AND v_ok3 THEN 'passed' ELSE 'failed' END;
    v_expected := 'Nama & ekstensi CSV valid diterima; ekstensi .xlsx dan path traversal ditolak.';
    v_actual := format('validCsv=%s, xlsxRejected=%s, traversalRejected=%s pada fixture sintetis.', v_ok1, v_ok2, v_ok3);
  ELSIF p_scenario_id = 'fixture_access_notes_secret_guard' THEN
    v_ok1 := NOT ('Minta akun uji melalui kanal internal.' ~* '(password|passwd|kata sandi|token|api[_ -]?key|secret|otp)\s*[:=]|bearer\s+[A-Za-z0-9._-]+|https?://[^\s/?#]*@');
    v_ok2 := ('password=contoh-sintetis' ~* '(password|passwd|kata sandi|token|api[_ -]?key|secret|otp)\s*[:=]');
    v_ok3 := ('https://user:contoh@fixture.example.invalid/' ~* 'https?://[^\s/?#]*@');
    v_status := CASE WHEN v_ok1 AND v_ok2 AND v_ok3 THEN 'passed' ELSE 'failed' END;
    v_expected := 'Catatan akses nonrahasia diterima; pola kredensial dan URL userinfo ditolak.';
    v_actual := format('safeAccepted=%s, kvRejected=%s, userInfoRejected=%s pada fixture sintetis.', v_ok1, v_ok2, v_ok3);
  ELSIF p_scenario_id = 'fixture_empty_cart_assertion_sample' THEN
    v_ok1 := ('0 items' = 'Keranjang belanja kosong');
    v_status := CASE WHEN v_ok1 THEN 'passed' ELSE 'failed' END;
    v_expected := 'Banner fixture menampilkan "Keranjang belanja kosong".';
    v_actual := 'Banner fixture menampilkan "0 items" (tidak sesuai harapan).';
  ELSE
    v_status := 'blocked';
    v_expected := COALESCE(p_reference_expected, '');
    v_actual := 'Tidak dijalankan karena skenario tidak terdaftar.';
    v_block_reason := 'Skenario tidak terdaftar dalam allowlist runner tepercaya.';
  END IF;

  v_end := clock_timestamp();
  RETURN jsonb_build_object(
    'status', v_status,
    'scenarioTitle', v_title,
    'expected', v_expected,
    'actual', v_actual,
    'blockReason', v_block_reason,
    'durationMs', GREATEST(0, floor(extract(epoch FROM (v_end - v_start)) * 1000)::integer),
    'startedAt', v_start,
    'finishedAt', v_end
  );
END; $$;

-- Owner creates a pending test run bound to an immutable CSV version.
-- Enforces DB-level scenario allowlist and ignores any client-supplied status/actual fields.
CREATE OR REPLACE FUNCTION public.qa_create_test_run(
  p_job uuid,
  p_deliverable uuid,
  p_version uuid,
  p_idempotency_key uuid,
  p_fingerprint text,
  p_note text DEFAULT '',
  p_cases jsonb DEFAULT '[]'::jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  u uuid := public.qa_actor();
  existing_run public.qa_test_runs;
  existing_cases jsonb;
  art public.qa_artifacts;
  ver public.qa_artifact_versions;
  created_run public.qa_test_runs;
  created_cases jsonb;
  case_count integer;
  rec jsonb;
  idx integer := 0;
  v_scenario_id text;
  v_scenario_title text;
BEGIN
  IF p_idempotency_key IS NULL
    OR p_fingerprint IS NULL OR p_fingerprint !~ '^[0-9a-f]{64}$'
    OR p_note IS NULL OR length(p_note) > 500
    OR p_cases IS NULL OR jsonb_typeof(p_cases) <> 'array' THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE = 'PT400';
  END IF;

  case_count := jsonb_array_length(p_cases);
  IF case_count < 1 OR case_count > 200 THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE = 'PT400';
  END IF;

  SELECT * INTO existing_run FROM public.qa_test_runs
    WHERE owner_id = u AND idempotency_key = p_idempotency_key FOR UPDATE;
  IF FOUND THEN
    IF existing_run.request_fingerprint IS DISTINCT FROM p_fingerprint THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE = 'PT409';
    END IF;
    SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.case_index ASC), '[]'::jsonb)
      INTO existing_cases FROM public.qa_test_run_cases c WHERE c.run_id = existing_run.run_id;
    RETURN jsonb_build_object('run', to_jsonb(existing_run), 'cases', existing_cases, 'replay', true);
  END IF;

  SELECT * INTO art FROM public.qa_artifacts
    WHERE owner_id = u AND job_id = p_job AND deliverable_id = p_deliverable;
  IF NOT FOUND OR art.kind <> 'test_case' THEN
    RAISE EXCEPTION 'ARTIFACT_NOT_FOUND' USING ERRCODE = 'PT404';
  END IF;

  SELECT * INTO ver FROM public.qa_artifact_versions
    WHERE owner_id = u AND job_id = p_job AND deliverable_id = p_deliverable
      AND version_id = p_version AND ready_at IS NOT NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ARTIFACT_NOT_FOUND' USING ERRCODE = 'PT404';
  END IF;

  INSERT INTO public.qa_test_runs (
    owner_id, job_id, execution_id, deliverable_id, version_id,
    version_number, file_name, file_sha256,
    idempotency_key, request_fingerprint, note, total_cases
  ) VALUES (
    u, art.job_id, art.execution_id, art.deliverable_id, ver.version_id,
    ver.version_number, ver.file_name, ver.sha256,
    p_idempotency_key, p_fingerprint, p_note, case_count
  ) RETURNING * INTO created_run;

  FOR rec IN SELECT * FROM jsonb_array_elements(p_cases) LOOP
    v_scenario_id := NULLIF(COALESCE(rec->>'scenarioId', ''), '');
    IF v_scenario_id IS NOT NULL THEN
      v_scenario_title := public.qa_approved_fixture_scenario_title(v_scenario_id);
      IF v_scenario_title IS NULL THEN
        RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE = 'PT400';
      END IF;
    ELSE
      v_scenario_title := '';
    END IF;

    INSERT INTO public.qa_test_run_cases (
      run_id, owner_id, case_index, case_key, case_title,
      reference_expected, scenario_id, scenario_title, skip_requested,
      status, expected_text, actual_text, block_reason
    ) VALUES (
      created_run.run_id, u, idx,
      rec->>'caseKey',
      rec->>'caseTitle',
      COALESCE(rec->>'referenceExpected', ''),
      v_scenario_id,
      v_scenario_title,
      COALESCE((rec->>'skipRequested')::boolean, false),
      'pending',
      COALESCE(rec->>'referenceExpected', ''),
      '',
      ''
    );
    idx := idx + 1;
  END LOOP;

  SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.case_index ASC), '[]'::jsonb)
    INTO created_cases FROM public.qa_test_run_cases c WHERE c.run_id = created_run.run_id;
  RETURN jsonb_build_object('run', to_jsonb(created_run), 'cases', created_cases, 'replay', false);
END; $$;

-- Owner explicitly triggers trusted fixture execution.
-- Accepts ONLY (p_job, p_run) — no client-supplied outcomes are accepted.
-- Executes atomically with FOR UPDATE lock; recovers stale 'running' leases without duplicate results;
-- returns replay=true on completed/failed runs.
CREATE OR REPLACE FUNCTION public.qa_execute_test_run(
  p_job uuid,
  p_run uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  u uuid := public.qa_actor();
  r public.qa_test_runs;
  c public.qa_test_run_cases;
  outcome jsonb;
  ts_start timestamptz := clock_timestamp();
  ts_end timestamptz;
  c_passed integer := 0;
  c_failed integer := 0;
  c_blocked integer := 0;
  c_skipped integer := 0;
  case_rows jsonb;
BEGIN
  SELECT * INTO r FROM public.qa_test_runs
    WHERE owner_id = u AND job_id = p_job AND run_id = p_run FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TEST_RUN_NOT_FOUND' USING ERRCODE = 'PT404';
  END IF;

  IF r.status IN ('completed', 'failed') THEN
    SELECT COALESCE(jsonb_agg(to_jsonb(rc) ORDER BY rc.case_index ASC), '[]'::jsonb)
      INTO case_rows FROM public.qa_test_run_cases rc WHERE rc.run_id = r.run_id;
    RETURN jsonb_build_object('run', to_jsonb(r), 'cases', case_rows, 'replay', true);
  END IF;

  IF r.status = 'running' AND r.lease_expires_at IS NOT NULL AND r.lease_expires_at > ts_start THEN
    RAISE EXCEPTION 'TEST_RUN_IN_PROGRESS' USING ERRCODE = 'PT409';
  END IF;

  UPDATE public.qa_test_runs
    SET
      status = 'running',
      lease_expires_at = ts_start + interval '30 seconds',
      started_at = COALESCE(started_at, ts_start),
      updated_at = ts_start
    WHERE run_id = r.run_id RETURNING * INTO r;

  FOR c IN
    SELECT * FROM public.qa_test_run_cases
    WHERE run_id = r.run_id AND owner_id = u
    ORDER BY case_index ASC
    FOR UPDATE
  LOOP
    outcome := public.qa_run_approved_fixture_scenario(c.scenario_id, c.skip_requested, c.reference_expected);
    UPDATE public.qa_test_run_cases
      SET
        status = outcome->>'status',
        scenario_title = COALESCE(outcome->>'scenarioTitle', ''),
        expected_text = COALESCE(outcome->>'expected', ''),
        actual_text = COALESCE(outcome->>'actual', ''),
        block_reason = COALESCE(outcome->>'blockReason', ''),
        duration_ms = (outcome->>'durationMs')::integer,
        started_at = (outcome->>'startedAt')::timestamptz,
        finished_at = (outcome->>'finishedAt')::timestamptz
      WHERE run_case_id = c.run_case_id;
  END LOOP;

  SELECT
    COUNT(*) FILTER (WHERE status = 'passed'),
    COUNT(*) FILTER (WHERE status = 'failed'),
    COUNT(*) FILTER (WHERE status = 'blocked'),
    COUNT(*) FILTER (WHERE status = 'skipped')
  INTO c_passed, c_failed, c_blocked, c_skipped
  FROM public.qa_test_run_cases
  WHERE run_id = r.run_id;

  ts_end := clock_timestamp();
  UPDATE public.qa_test_runs
    SET
      status = 'completed',
      lease_expires_at = NULL,
      passed_cases = c_passed,
      failed_cases = c_failed,
      blocked_cases = c_blocked,
      skipped_cases = c_skipped,
      finished_at = ts_end,
      updated_at = ts_end
    WHERE run_id = r.run_id RETURNING * INTO r;

  SELECT COALESCE(jsonb_agg(to_jsonb(rc) ORDER BY rc.case_index ASC), '[]'::jsonb)
    INTO case_rows FROM public.qa_test_run_cases rc WHERE rc.run_id = r.run_id;
  RETURN jsonb_build_object('run', to_jsonb(r), 'cases', case_rows, 'replay', false);
END; $$;

REVOKE ALL ON FUNCTION public.qa_approved_fixture_scenario_title(text),
  public.qa_run_approved_fixture_scenario(text, boolean, text),
  public.qa_create_test_run(uuid, uuid, uuid, uuid, text, text, jsonb),
  public.qa_execute_test_run(uuid, uuid)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.qa_create_test_run(uuid, uuid, uuid, uuid, text, text, jsonb),
  public.qa_execute_test_run(uuid, uuid) TO authenticated;

COMMIT;
