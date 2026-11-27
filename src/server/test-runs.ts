import "./only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  CreateTestRunInput,
  CsvVersionCasesResponse,
  TestRun,
  TestRunCase,
  TestRunCaseStatus,
  TestRunStatus,
} from "../contracts/test-runs";
import { readVerifiedArtifactVersionBytes } from "./artifacts";
import type { AppConfig } from "./config";
import { databaseFault } from "./database-errors";
import { assert } from "./errors";
import {
  getApprovedScenario,
  listApprovedScenarios,
  parseCsvReferenceCases,
} from "./test-scenarios";

type TestRunRow = {
  run_id: string;
  job_id: string;
  execution_id: string;
  deliverable_id: string;
  version_id: string;
  version_number: number;
  file_name: string;
  file_sha256: string;
  mode: "limited_functional_fixture";
  environment: "synthetic_fixture";
  status: TestRunStatus;
  note: string;
  total_cases: number;
  passed_cases: number;
  failed_cases: number;
  blocked_cases: number;
  skipped_cases: number;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
};

type TestRunCaseRow = {
  run_case_id: string;
  case_index: number;
  case_key: string;
  case_title: string;
  reference_expected: string;
  scenario_id: string | null;
  scenario_title: string;
  skip_requested: boolean;
  status: TestRunCaseStatus;
  expected_text: string;
  actual_text: string;
  block_reason: string;
  duration_ms: number | null;
  started_at: string | null;
  finished_at: string | null;
};

export type VersionBytesLoader = typeof readVerifiedArtifactVersionBytes;

const runColumns = [
  "run_id", "job_id", "execution_id", "deliverable_id", "version_id",
  "version_number", "file_name", "file_sha256", "mode", "environment",
  "status", "note", "total_cases", "passed_cases", "failed_cases",
  "blocked_cases", "skipped_cases", "started_at", "finished_at",
  "created_at", "updated_at",
].join(",");

const caseColumns = [
  "run_case_id", "case_index", "case_key", "case_title", "reference_expected",
  "scenario_id", "scenario_title", "skip_requested", "status", "expected_text",
  "actual_text", "block_reason", "duration_ms", "started_at", "finished_at",
].join(",");

function caseDto(row: TestRunCaseRow): TestRunCase {
  return {
    runCaseId: row.run_case_id,
    caseIndex: row.case_index,
    caseKey: row.case_key,
    caseTitle: row.case_title,
    referenceExpected: row.reference_expected,
    scenarioId: row.scenario_id,
    scenarioTitle: row.scenario_title,
    skipRequested: row.skip_requested,
    status: row.status,
    expected: row.expected_text,
    actual: row.actual_text,
    blockReason: row.block_reason,
    durationMs: row.duration_ms,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function runDto(row: TestRunRow, cases?: TestRunCaseRow[]): TestRun {
  const dto: TestRun = {
    runId: row.run_id,
    jobId: row.job_id,
    executionId: row.execution_id,
    deliverableId: row.deliverable_id,
    versionId: row.version_id,
    versionNumber: row.version_number,
    fileName: row.file_name,
    fileSha256: row.file_sha256,
    mode: row.mode,
    environment: row.environment,
    status: row.status,
    note: row.note,
    counts: {
      total: row.total_cases,
      passed: row.passed_cases,
      failed: row.failed_cases,
      blocked: row.blocked_cases,
      skipped: row.skipped_cases,
    },
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (cases) dto.cases = cases.map(caseDto);
  return dto;
}

function requestFingerprint(jobId: string, input: CreateTestRunInput): string {
  const canonical = JSON.stringify({
    jobId,
    deliverableId: input.deliverableId,
    versionId: input.versionId,
    note: input.note,
    selectedCases: input.selectedCases.map(c => ({
      caseKey: c.caseKey,
      scenarioId: c.scenarioId ?? null,
      skip: Boolean(c.skip),
    })),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export async function listVersionCsvCases(
  client: SupabaseClient,
  config: AppConfig,
  ownerId: string,
  jobId: string,
  deliverableId: string,
  versionId: string,
  loadVersionBytes: VersionBytesLoader = readVerifiedArtifactVersionBytes,
): Promise<CsvVersionCasesResponse> {
  const artifact = await loadVersionBytes(client, config, ownerId, jobId, deliverableId, versionId);
  assert(artifact.kind === "test_case", 400, "INVALID_REQUEST", "Daftar case hanya tersedia untuk deliverable Test Case (CSV).");
  const csvText = new TextDecoder("utf-8", { fatal: true }).decode(artifact.bytes);
  const cases = parseCsvReferenceCases(csvText);
  return {
    deliverableId: artifact.deliverableId,
    versionId: artifact.versionId,
    versionNumber: artifact.versionNumber,
    fileName: artifact.fileName,
    fileSha256: artifact.sha256,
    mode: "limited_functional_fixture",
    environment: "synthetic_fixture",
    scenarios: listApprovedScenarios(),
    cases,
  };
}

export async function listJobTestRuns(client: SupabaseClient, jobId: string) {
  const { data, error } = await client.from("qa_test_runs")
    .select(runColumns)
    .eq("job_id", jobId)
    .order("created_at", { ascending: false })
    .order("run_id", { ascending: false })
    .limit(50);
  if (error) throw databaseFault(error);
  return {
    runs: ((data ?? []) as unknown as TestRunRow[]).map(row => runDto(row)),
    scenarios: listApprovedScenarios(),
  };
}

export async function getJobTestRun(client: SupabaseClient, jobId: string, runId: string): Promise<{ run: TestRun }> {
  const [{ data: runRow, error: runError }, { data: caseRows, error: caseError }] = await Promise.all([
    client.from("qa_test_runs").select(runColumns).eq("job_id", jobId).eq("run_id", runId).maybeSingle(),
    client.from("qa_test_run_cases").select(caseColumns).eq("run_id", runId).order("case_index", { ascending: true }),
  ]);
  if (runError) throw databaseFault(runError);
  if (caseError) throw databaseFault(caseError);
  assert(runRow, 404, "TEST_RUN_NOT_FOUND", "Sesi pengujian tidak ditemukan.");
  return { run: runDto(runRow as unknown as TestRunRow, (caseRows ?? []) as unknown as TestRunCaseRow[]) };
}

export async function createJobTestRun(
  client: SupabaseClient,
  config: AppConfig,
  ownerId: string,
  jobId: string,
  idempotencyKey: string,
  input: CreateTestRunInput,
  loadVersionBytes: VersionBytesLoader = readVerifiedArtifactVersionBytes,
): Promise<{ run: TestRun; replay: boolean }> {
  const artifact = await loadVersionBytes(client, config, ownerId, jobId, input.deliverableId, input.versionId);
  assert(artifact.kind === "test_case", 400, "INVALID_REQUEST", "Sesi pengujian hanya mendukung deliverable Test Case (CSV).");
  const csvText = new TextDecoder("utf-8", { fatal: true }).decode(artifact.bytes);
  const parsedCases = parseCsvReferenceCases(csvText);
  const byKey = new Map(parsedCases.map(c => [c.caseKey, c]));

  const resolvedCases = input.selectedCases.map(selection => {
    const ref = byKey.get(selection.caseKey);
    assert(ref, 400, "INVALID_REQUEST", `Case "${selection.caseKey}" tidak ditemukan pada versi CSV yang dipilih.`);
    const scenarioId = selection.scenarioId ?? null;
    let scenarioTitle = "";
    if (scenarioId !== null) {
      const scenario = getApprovedScenario(scenarioId);
      assert(scenario, 400, "INVALID_REQUEST", `Skenario "${scenarioId}" tidak terdaftar dalam katalog skenario yang disetujui.`);
      scenarioTitle = scenario.title;
    }
    return {
      caseKey: ref.caseKey,
      caseTitle: ref.title,
      referenceExpected: ref.expected,
      scenarioId,
      scenarioTitle,
      skipRequested: Boolean(selection.skip),
    };
  });

  const { data, error } = await client.rpc("qa_create_test_run", {
    p_job: jobId,
    p_deliverable: input.deliverableId,
    p_version: input.versionId,
    p_idempotency_key: idempotencyKey,
    p_fingerprint: requestFingerprint(jobId, input),
    p_note: input.note,
    p_cases: resolvedCases,
  });
  if (error) throw databaseFault(error);
  const payload = data as { run: TestRunRow; cases: TestRunCaseRow[]; replay: boolean };
  return { run: runDto(payload.run, payload.cases), replay: Boolean(payload.replay) };
}

export async function executeJobTestRun(
  client: SupabaseClient,
  jobId: string,
  runId: string,
): Promise<{ run: TestRun; replay: boolean }> {
  // Trusted runner execution happens strictly inside the SECURITY DEFINER Postgres boundary.
  // No client-supplied outcomes or results are ever passed to the database.
  const executed = await client.rpc("qa_execute_test_run", {
    p_job: jobId,
    p_run: runId,
  });
  if (executed.error) throw databaseFault(executed.error);
  const payload = executed.data as { run: TestRunRow; cases: TestRunCaseRow[]; replay: boolean };
  return { run: runDto(payload.run, payload.cases), replay: Boolean(payload.replay) };
}
