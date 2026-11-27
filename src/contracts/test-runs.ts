import { z } from "zod";
import { uuidSchema } from "./index";

export const testRunModeSchema = z.literal("limited_functional_fixture");
export type TestRunMode = z.infer<typeof testRunModeSchema>;

export const testRunEnvironmentSchema = z.literal("synthetic_fixture");
export type TestRunEnvironment = z.infer<typeof testRunEnvironmentSchema>;

export const testRunStatusSchema = z.enum(["created", "running", "completed", "failed"]);
export type TestRunStatus = z.infer<typeof testRunStatusSchema>;

export const testRunCaseStatusSchema = z.enum(["pending", "passed", "failed", "blocked", "skipped"]);
export type TestRunCaseStatus = z.infer<typeof testRunCaseStatusSchema>;

export const testRunCaseSelectionSchema = z.strictObject({
  caseKey: z.string().trim().min(1).max(120),
  scenarioId: z.string().trim().min(1).max(80).nullable().optional(),
  skip: z.boolean().optional().default(false),
});

export const createTestRunSchema = z.strictObject({
  deliverableId: uuidSchema,
  versionId: uuidSchema,
  note: z.string().trim().max(500).optional().default(""),
  selectedCases: z.array(testRunCaseSelectionSchema)
    .min(1)
    .max(200)
    .refine(items => new Set(items.map(item => item.caseKey)).size === items.length, {
      message: "caseKey tidak boleh duplikat dalam satu sesi.",
    }),
});

export type CreateTestRunInput = z.infer<typeof createTestRunSchema>;

export type ApprovedScenario = {
  scenarioId: string;
  title: string;
  summary: string;
  fixtureTarget: string;
  defaultCaseKeys: readonly string[];
  expectedOutcomeHint: "passed" | "failed";
};

export type CsvReferenceCase = {
  rowIndex: number;
  caseKey: string;
  title: string;
  expected: string;
  module: string;
  priority: string;
  suggestedScenarioId: string | null;
  runnableByDefault: boolean;
};

export type TestRunCase = {
  runCaseId: string;
  caseIndex: number;
  caseKey: string;
  caseTitle: string;
  referenceExpected: string;
  scenarioId: string | null;
  scenarioTitle: string;
  skipRequested: boolean;
  status: TestRunCaseStatus;
  expected: string;
  actual: string;
  blockReason: string;
  durationMs: number | null;
  startedAt: string | null;
  finishedAt: string | null;
};

export type TestRunCounts = {
  total: number;
  passed: number;
  failed: number;
  blocked: number;
  skipped: number;
};

export type TestRun = {
  runId: string;
  jobId: string;
  executionId: string;
  deliverableId: string;
  versionId: string;
  versionNumber: number;
  fileName: string;
  fileSha256: string;
  mode: TestRunMode;
  environment: TestRunEnvironment;
  status: TestRunStatus;
  note: string;
  counts: TestRunCounts;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  cases?: TestRunCase[];
};

export type CsvVersionCasesResponse = {
  deliverableId: string;
  versionId: string;
  versionNumber: number;
  fileName: string;
  fileSha256: string;
  mode: TestRunMode;
  environment: TestRunEnvironment;
  scenarios: ApprovedScenario[];
  cases: CsvReferenceCase[];
};
