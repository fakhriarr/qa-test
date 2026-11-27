import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createTestRunSchema } from "../src/contracts/test-runs";
import {
  executeApprovedScenario,
  listApprovedScenarios,
  parseCsvReferenceCases,
} from "../src/server/test-scenarios";
import {
  createJobTestRun,
  executeJobTestRun,
  getJobTestRun,
  listJobTestRuns,
  listVersionCsvCases,
  type VersionBytesLoader,
} from "../src/server/test-runs";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const EXEC_ID = "22222222-2222-4222-8222-222222222222";
const DELIV_ID = "33333333-3333-4333-8333-333333333333";
const VER_ID = "44444444-4444-4444-8444-444444444444";
const IDEMP_KEY = "55555555-5555-4555-8555-555555555555";
const OTHER_KEY = "66666666-6666-4666-8666-666666666666";

const syntheticCsv = [
  'Test Case ID,Module,Title,Expected Result,Priority',
  'FX-REQ-001,Request,"Validasi draf & submit sintetis","Draf valid dan submit lulus",High',
  'FX-FAIL-001,Cart,"Banner keranjang kosong","Menampilkan pesan Keranjang belanja kosong",Medium',
  'TC-UNMAPPED-001,Landing,"Cek tombol eksternal https://untrusted.example.invalid; alert(1)","Harus terblokir tanpa skenario",Low',
  'TC-SKIP-001,Auth,"Kasus dilewati pemilik","Dilewati oleh pemilik",Low',
].join("\n") + "\n";

test("createTestRunSchema rejects client-supplied outcome fields, duplicate caseKeys, and empty selections", () => {
  assert.equal(createTestRunSchema.safeParse({
    deliverableId: DELIV_ID,
    versionId: VER_ID,
    selectedCases: [],
  }).success, false);
  assert.equal(createTestRunSchema.safeParse({
    deliverableId: DELIV_ID,
    versionId: VER_ID,
    selectedCases: [{ caseKey: "FX-REQ-001" }, { caseKey: "FX-REQ-001" }],
  }).success, false);
  // Client-supplied outcome fields must be rejected at schema boundary.
  assert.equal(createTestRunSchema.safeParse({
    deliverableId: DELIV_ID,
    versionId: VER_ID,
    selectedCases: [{ caseKey: "FX-REQ-001", scenarioId: "fixture_request_draft_validation", status: "passed" }],
  }).success, false);
  assert.equal(createTestRunSchema.safeParse({
    deliverableId: DELIV_ID,
    versionId: VER_ID,
    selectedCases: [{ caseKey: "FX-REQ-001", scenarioId: "fixture_request_draft_validation", actual: "forged" }],
  }).success, false);
  assert.equal(createTestRunSchema.safeParse({
    deliverableId: DELIV_ID,
    versionId: VER_ID,
    selectedCases: [{ caseKey: "FX-REQ-001", scenarioId: "fixture_request_draft_validation" }],
    results: [{ caseKey: "FX-REQ-001", status: "passed" }],
  }).success, false);
  const parsed = createTestRunSchema.parse({
    deliverableId: DELIV_ID,
    versionId: VER_ID,
    selectedCases: [{ caseKey: "FX-REQ-001", scenarioId: "fixture_request_draft_validation" }],
  });
  assert.equal(parsed.note, "");
  assert.equal(parsed.selectedCases[0].skip, false);
});

test("migration 008 enforces trusted runner provenance without client-supplied outcome RPCs or service_role", () => {
  const sql = readFileSync(new URL("../supabase/migrations/008_qa_test_runs.sql", import.meta.url), "utf8");
  assert.equal(/qa_finish_test_run/i.test(sql), false, "qa_finish_test_run must not exist");
  assert.equal(/qa_start_test_run/i.test(sql), false, "qa_start_test_run must not exist");
  assert.equal(/service_role/i.test(sql), false, "must not grant or depend on service_role");
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.qa_execute_test_run\(\s*p_job uuid,\s*p_run uuid\s*\)/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.qa_approved_fixture_scenario_title\(text\),\s*public\.qa_run_approved_fixture_scenario\(text, boolean, text\)/);
  assert.match(sql, /GRANT SELECT ON public\.qa_test_runs, public\.qa_test_run_cases TO authenticated;/);
  assert.equal(/GRANT\s+(?:INSERT|UPDATE|DELETE)\s+ON\s+public\.qa_test_run/i.test(sql), false);
  assert.match(sql, /lease_expires_at\s+timestamptz/);
});

test("parseCsvReferenceCases treats CSV strictly as reference data and maps only approved fixtures", () => {
  const cases = parseCsvReferenceCases(syntheticCsv);
  assert.equal(cases.length, 4);
  assert.equal(cases[0].caseKey, "FX-REQ-001");
  assert.equal(cases[0].suggestedScenarioId, "fixture_request_draft_validation");
  assert.equal(cases[0].runnableByDefault, true);
  assert.equal(cases[2].caseKey, "TC-UNMAPPED-001");
  assert.equal(cases[2].suggestedScenarioId, null);
  assert.equal(cases[2].runnableByDefault, false);
});

test("executeApprovedScenario produces passed, failed, blocked, and skipped deterministically without network", () => {
  assert.equal(listApprovedScenarios().length, 5);

  assert.equal(executeApprovedScenario("fixture_request_draft_validation", false, "ref").status, "passed");
  assert.equal(executeApprovedScenario("fixture_scope_anchor_normalization", false, "ref").status, "passed");
  assert.equal(executeApprovedScenario("fixture_csv_rfc4180_integrity", false, "ref").status, "passed");
  assert.equal(executeApprovedScenario("fixture_access_notes_secret_guard", false, "ref").status, "passed");

  const fail = executeApprovedScenario("fixture_empty_cart_assertion_sample", false, "ref");
  assert.equal(fail.status, "failed");
  assert.match(fail.actual, /tidak sesuai harapan/i);

  const blockedNull = executeApprovedScenario(null, false, "ref expected");
  assert.equal(blockedNull.status, "blocked");
  assert.ok(blockedNull.blockReason.length > 0);

  const blockedUnknown = executeApprovedScenario("unapproved_or_dynamic_script", false, "ref expected");
  assert.equal(blockedUnknown.status, "blocked");

  const skipped = executeApprovedScenario("fixture_request_draft_validation", true, "ref expected");
  assert.equal(skipped.status, "skipped");
});

test("test run lifecycle invokes trusted qa_execute_test_run without client outcomes, enforces lease recovery, and isolates owners", async () => {
  const csvBytes = Buffer.from(syntheticCsv, "utf8");
  const csvSha = createHash("sha256").update(csvBytes).digest("hex");
  const config = { supabaseUrl: "https://storage.example", publishableKey: "test-key", origin: "https://app.example" };

  const loader: VersionBytesLoader = async (_client, _cfg, ownerId, jobId, itemId, versionId) => {
    if (ownerId !== "owner-1" || jobId !== JOB_ID || itemId !== DELIV_ID || versionId !== VER_ID) {
      const err = new Error("not found") as Error & { code?: string };
      err.code = "ARTIFACT_NOT_FOUND";
      throw err;
    }
    return {
      deliverableId: DELIV_ID,
      versionId: VER_ID,
      versionNumber: 2,
      kind: "test_case",
      fileName: "synthetic_cases.csv",
      sizeBytes: csvBytes.length,
      sha256: csvSha,
      bytes: csvBytes,
    };
  };

  type StoredRun = {
    run_id: string; owner_id: string; job_id: string; execution_id: string;
    deliverable_id: string; version_id: string; version_number: number;
    file_name: string; file_sha256: string; idempotency_key: string; request_fingerprint: string;
    mode: "limited_functional_fixture"; environment: "synthetic_fixture";
    status: "created" | "running" | "completed" | "failed"; note: string;
    total_cases: number; passed_cases: number; failed_cases: number; blocked_cases: number; skipped_cases: number;
    lease_expires_at: string | null;
    started_at: string | null; finished_at: string | null; created_at: string; updated_at: string;
  };
  type StoredCase = {
    run_case_id: string; run_id: string; owner_id: string; case_index: number;
    case_key: string; case_title: string; reference_expected: string;
    scenario_id: string | null; scenario_title: string; skip_requested: boolean;
    status: "pending" | "passed" | "failed" | "blocked" | "skipped";
    expected_text: string; actual_text: string; block_reason: string;
    duration_ms: number | null; started_at: string | null; finished_at: string | null;
  };

  const runs = new Map<string, StoredRun>();
  const runCases = new Map<string, StoredCase[]>();

  const makeClient = (ownerId: string) => ({
    from: (table: string) => {
      const filters: Record<string, string> = {};
      const q = {
        select: () => q,
        eq: (k: string, v: string) => { filters[k] = v; return q; },
        order: () => q,
        limit: async () => {
          if (table === "qa_test_runs") {
            const list = [...runs.values()].filter(r => r.owner_id === ownerId && r.job_id === filters.job_id);
            return { data: list, error: null };
          }
          return { data: [], error: null };
        },
        maybeSingle: async () => {
          if (table === "qa_test_runs") {
            const found = [...runs.values()].find(r =>
              r.owner_id === ownerId && r.job_id === filters.job_id && r.run_id === filters.run_id);
            return { data: found ?? null, error: null };
          }
          return { data: null, error: null };
        },
        then: (resolve: (val: unknown) => void) => {
          if (table === "qa_test_run_cases") {
            const rows = (runCases.get(filters.run_id) ?? []).filter(c => c.owner_id === ownerId);
            resolve({ data: rows, error: null });
          } else {
            resolve({ data: [], error: null });
          }
        },
      };
      return q;
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === "qa_create_test_run") {
        const existing = [...runs.values()].find(r =>
          r.owner_id === ownerId && r.idempotency_key === args.p_idempotency_key);
        if (existing) {
          if (existing.request_fingerprint !== args.p_fingerprint) {
            return { data: null, error: { code: "PT409", message: "IDEMPOTENCY_CONFLICT" } };
          }
          return { data: { run: existing, cases: runCases.get(existing.run_id) ?? [], replay: true }, error: null };
        }
        const runId = `77777777-7777-4777-8777-77777777777${runs.size + 1}`;
        const rawCases = args.p_cases as Array<{
          caseKey: string; caseTitle: string; referenceExpected: string;
          scenarioId: string | null; scenarioTitle: string; skipRequested: boolean;
        }>;
        const now = "2026-11-27T09:50:00Z";
        const row: StoredRun = {
          run_id: runId, owner_id: ownerId, job_id: String(args.p_job), execution_id: EXEC_ID,
          deliverable_id: String(args.p_deliverable), version_id: String(args.p_version),
          version_number: 2, file_name: "synthetic_cases.csv", file_sha256: csvSha,
          idempotency_key: String(args.p_idempotency_key), request_fingerprint: String(args.p_fingerprint),
          mode: "limited_functional_fixture", environment: "synthetic_fixture",
          status: "created", note: String(args.p_note ?? ""),
          total_cases: rawCases.length, passed_cases: 0, failed_cases: 0, blocked_cases: 0, skipped_cases: 0,
          lease_expires_at: null,
          started_at: null, finished_at: null, created_at: now, updated_at: now,
        };
        const cases: StoredCase[] = rawCases.map((c, idx) => ({
          run_case_id: `88888888-8888-4888-8888-88888888888${idx + 1}`,
          run_id: runId, owner_id: ownerId, case_index: idx,
          case_key: c.caseKey, case_title: c.caseTitle, reference_expected: c.referenceExpected,
          scenario_id: c.scenarioId, scenario_title: c.scenarioTitle, skip_requested: c.skipRequested,
          status: "pending", expected_text: c.referenceExpected, actual_text: "", block_reason: "",
          duration_ms: null, started_at: null, finished_at: null,
        }));
        runs.set(runId, row);
        runCases.set(runId, cases);
        return { data: { run: row, cases, replay: false }, error: null };
      }
      if (name === "qa_execute_test_run") {
        // Defensive check: caller must NEVER pass results/outcomes to execution RPC.
        assert.deepEqual(Object.keys(args).sort(), ["p_job", "p_run"]);
        const row = runs.get(String(args.p_run));
        if (!row || row.owner_id !== ownerId || row.job_id !== args.p_job) {
          return { data: null, error: { code: "PT404", message: "TEST_RUN_NOT_FOUND" } };
        }
        const cases = runCases.get(row.run_id) ?? [];
        if (row.status === "completed" || row.status === "failed") {
          return { data: { run: row, cases, replay: true }, error: null };
        }
        if (row.status === "running" && row.lease_expires_at && Date.parse(row.lease_expires_at) > Date.now()) {
          return { data: null, error: { code: "PT409", message: "TEST_RUN_IN_PROGRESS" } };
        }
        row.status = "running";
        row.started_at = row.started_at ?? "2026-11-27T09:50:01Z";
        for (const item of cases) {
          const outcome = executeApprovedScenario(item.scenario_id, item.skip_requested, item.reference_expected);
          item.status = outcome.status;
          item.scenario_title = outcome.scenarioTitle;
          item.expected_text = outcome.expected;
          item.actual_text = outcome.actual;
          item.block_reason = outcome.blockReason;
          item.duration_ms = outcome.durationMs;
          item.started_at = outcome.startedAt;
          item.finished_at = outcome.finishedAt;
        }
        row.status = "completed";
        row.lease_expires_at = null;
        row.passed_cases = cases.filter(c => c.status === "passed").length;
        row.failed_cases = cases.filter(c => c.status === "failed").length;
        row.blocked_cases = cases.filter(c => c.status === "blocked").length;
        row.skipped_cases = cases.filter(c => c.status === "skipped").length;
        row.finished_at = "2026-11-27T09:50:02Z";
        row.updated_at = row.finished_at;
        return { data: { run: row, cases, replay: false }, error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    },
  }) as unknown as Parameters<typeof listJobTestRuns>[0];

  const ownerClient = makeClient("owner-1");
  const otherClient = makeClient("owner-2");

  // 1. Read CSV reference cases
  const catalog = await listVersionCsvCases(ownerClient, config, "owner-1", JOB_ID, DELIV_ID, VER_ID, loader);
  assert.equal(catalog.cases.length, 4);
  assert.equal(catalog.versionNumber, 2);

  // 2. Reject unknown scenarioId and unknown caseKey
  await assert.rejects(
    createJobTestRun(ownerClient, config, "owner-1", JOB_ID, OTHER_KEY, {
      deliverableId: DELIV_ID, versionId: VER_ID, note: "",
      selectedCases: [{ caseKey: "FX-REQ-001", scenarioId: "evil_script", skip: false }],
    }, loader),
    { code: "INVALID_REQUEST" },
  );
  await assert.rejects(
    createJobTestRun(ownerClient, config, "owner-1", JOB_ID, OTHER_KEY, {
      deliverableId: DELIV_ID, versionId: VER_ID, note: "",
      selectedCases: [{ caseKey: "DOES-NOT-EXIST", scenarioId: null, skip: false }],
    }, loader),
    { code: "INVALID_REQUEST" },
  );

  // 3. Create session with 4 cases covering passed, failed, blocked, skipped
  const input = {
    deliverableId: DELIV_ID,
    versionId: VER_ID,
    note: "Sesi verifikasi fixture sintetis",
    selectedCases: [
      { caseKey: "FX-REQ-001", scenarioId: "fixture_request_draft_validation", skip: false },
      { caseKey: "FX-FAIL-001", scenarioId: "fixture_empty_cart_assertion_sample", skip: false },
      { caseKey: "TC-UNMAPPED-001", scenarioId: null, skip: false },
      { caseKey: "TC-SKIP-001", scenarioId: null, skip: true },
    ],
  };
  const created = await createJobTestRun(ownerClient, config, "owner-1", JOB_ID, IDEMP_KEY, input, loader);
  assert.equal(created.replay, false);
  assert.equal(created.run.status, "created");

  // 4. Idempotent replay & conflict
  const replayed = await createJobTestRun(ownerClient, config, "owner-1", JOB_ID, IDEMP_KEY, input, loader);
  assert.equal(replayed.replay, true);
  assert.equal(replayed.run.runId, created.run.runId);
  await assert.rejects(
    createJobTestRun(ownerClient, config, "owner-1", JOB_ID, IDEMP_KEY, { ...input, note: "Changed note" }, loader),
    { code: "IDEMPOTENCY_CONFLICT" },
  );

  // 5. Simulate active running lease (must reject concurrent execute with 409 TEST_RUN_IN_PROGRESS)
  const stored = runs.get(created.run.runId)!;
  stored.status = "running";
  stored.lease_expires_at = new Date(Date.now() + 30_000).toISOString();
  await assert.rejects(executeJobTestRun(ownerClient, JOB_ID, created.run.runId), { code: "TEST_RUN_IN_PROGRESS" });

  // 6. Simulate expired running lease (transient failure recovery without duplicate results)
  stored.lease_expires_at = new Date(Date.now() - 5_000).toISOString();
  const recovered = await executeJobTestRun(ownerClient, JOB_ID, created.run.runId);
  assert.equal(recovered.replay, false);
  assert.equal(recovered.run.status, "completed");
  assert.deepEqual(recovered.run.counts, { total: 4, passed: 1, failed: 1, blocked: 1, skipped: 1 });
  assert.equal(recovered.run.cases?.length, 4);

  // 7. Re-executing completed run is idempotent
  const execReplay = await executeJobTestRun(ownerClient, JOB_ID, created.run.runId);
  assert.equal(execReplay.replay, true);
  assert.equal(execReplay.run.runId, created.run.runId);

  // 8. Owner listing & detail work; other account gets 404
  assert.equal((await listJobTestRuns(ownerClient, JOB_ID)).runs.length, 1);
  assert.equal((await getJobTestRun(ownerClient, JOB_ID, created.run.runId)).run.cases?.length, 4);
  await assert.rejects(getJobTestRun(otherClient, JOB_ID, created.run.runId), { code: "TEST_RUN_NOT_FOUND" });
  await assert.rejects(executeJobTestRun(otherClient, JOB_ID, created.run.runId), { code: "TEST_RUN_NOT_FOUND" });
});
