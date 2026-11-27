import "./only";
import {
  draftDataSchema,
  scopeUrl,
  submissionSchema,
} from "../contracts/requests";
import type { ApprovedScenario, CsvReferenceCase } from "../contracts/test-runs";
import { validArtifact } from "./artifact-format";
import { visibleLinkCandidates } from "./discovery";

const MAX_PARSED_ROWS = 500;

export type ScenarioExecutionResult = {
  status: "passed" | "failed" | "blocked" | "skipped";
  scenarioId: string | null;
  scenarioTitle: string;
  expected: string;
  actual: string;
  blockReason: string;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
};

type ScenarioRunner = {
  meta: ApprovedScenario;
  run: () => { status: "passed" | "failed"; expected: string; actual: string };
};

// Developer-authored, read-only, in-process functional scenarios running exclusively on
// synthetic project fixtures (RFC 2606 *.example.invalid). No external network, no dynamic
// execution of CSV text, no browser automation, and no real target access.
const SCENARIO_RUNNERS: readonly ScenarioRunner[] = [
  {
    meta: {
      scenarioId: "fixture_request_draft_validation",
      title: "Validasi draf & submit permintaan QA (fixture sintetis)",
      summary: "Memastikan draf parsial diterima, field liar ditolak, dan payload submit lengkap lulus validasi kontrak pada fixture sintetis.",
      fixtureTarget: "https://fixture.example.invalid/",
      defaultCaseKeys: ["FX-REQ-001", "TC-FIXTURE-001"],
      expectedOutcomeHint: "passed",
    },
    run: () => {
      const partialOk = draftDataSchema.safeParse({ targetUrl: "https:", environment: "staging" }).success;
      const extraFieldRejected = !draftDataSchema.safeParse({ targetUrl: "https://fixture.example.invalid/", unexpected: true }).success;
      const submitOk = submissionSchema.safeParse({
        targetUrl: "https://fixture.example.invalid/",
        environment: "staging",
        scopeUrls: ["https://fixture.example.invalid/catalog"],
        acceptanceCriteria: ["Halaman katalog tampil dengan pesan kosong yang jelas."],
        deliverables: ["test_plan", "test_case"],
      }).success;
      const passed = partialOk && extraFieldRejected && submitOk;
      return {
        status: passed ? "passed" : "failed",
        expected: "Draf parsial valid, field tak dikenal ditolak, dan submit lengkap lulus skema kontrak.",
        actual: `partialOk=${partialOk}, extraFieldRejected=${extraFieldRejected}, submitOk=${submitOk} pada fixture sintetis.`,
      };
    },
  },
  {
    meta: {
      scenarioId: "fixture_scope_anchor_normalization",
      title: "Normalisasi & deduplikasi URL anchor cakupan (fixture HTML sintetis)",
      summary: "Memastikan parser HTML statis mempertahankan anchor satu origin yang valid, membuang anchor kosong dan tautan eksternal pada fixture sintetis.",
      fixtureTarget: "https://fixture.example.invalid/",
      defaultCaseKeys: ["FX-SCOPE-001", "TC-FIXTURE-002"],
      expectedOutcomeHint: "passed",
    },
    run: () => {
      const html = `<!doctype html><html><body>
        <a href="#pricing">Pricing</a><a href="/#pricing">Duplicate</a>
        <a href="#">Empty</a><a href="/docs#api">Docs API</a>
        <a href="https://other.example.invalid/#external">External</a>
      </body></html>`;
      const candidates = visibleLinkCandidates(html, new URL("https://fixture.example.invalid/"));
      const expectedCandidates = [
        "https://fixture.example.invalid/#pricing",
        "https://fixture.example.invalid/docs#api",
      ];
      const allValid = candidates.every(url => scopeUrl.safeParse(url).success);
      const exactMatch = JSON.stringify(candidates) === JSON.stringify(expectedCandidates);
      const passed = allValid && exactMatch;
      return {
        status: passed ? "passed" : "failed",
        expected: `Kandidat satu origin terdeduplikasi: ${expectedCandidates.join(", ")}.`,
        actual: `Hasil parser (${candidates.length} kandidat): ${candidates.join(", ")}; semua valid scopeUrl=${allValid}.`,
      };
    },
  },
  {
    meta: {
      scenarioId: "fixture_csv_rfc4180_integrity",
      title: "Validasi integritas CSV RFC 4180 & penolakan non-CSV (fixture sintetis)",
      summary: "Memastikan validator artefak menerima CSV RFC 4180 valid serta menolak kutip tak tertutup dan ekstensi .xlsx untuk deliverable test_case.",
      fixtureTarget: "in-process://artifact-format",
      defaultCaseKeys: ["FX-CSV-001", "TC-FIXTURE-003"],
      expectedOutcomeHint: "passed",
    },
    run: () => {
      const validCsv = validArtifact("test_case", "fixture_cases.csv", Buffer.from('id,title,expected\nFX-1,"Kasus, valid","Lulus"\n'));
      const brokenCsvRejected = !validArtifact("test_case", "broken.csv", Buffer.from('id,title\nFX-1,"kutip tak ditutup'));
      const xlsxRejected = !validArtifact("test_case", "companion.xlsx", Buffer.from("id,title\nFX-1,xlsx\n"));
      const passed = validCsv && brokenCsvRejected && xlsxRejected;
      return {
        status: passed ? "passed" : "failed",
        expected: "CSV RFC 4180 valid diterima; CSV rusak dan ekstensi .xlsx ditolak.",
        actual: `validCsv=${validCsv}, brokenCsvRejected=${brokenCsvRejected}, xlsxRejected=${xlsxRejected}.`,
      };
    },
  },
  {
    meta: {
      scenarioId: "fixture_access_notes_secret_guard",
      title: "Guard penolakan pola kredensial pada catatan akses (fixture sintetis)",
      summary: "Memastikan instruksi akses nonrahasia diterima sementara teks berpola kredensial atau URL userinfo ditolak.",
      fixtureTarget: "in-process://requests-contract",
      defaultCaseKeys: ["FX-SEC-001", "TC-FIXTURE-004"],
      expectedOutcomeHint: "passed",
    },
    run: () => {
      const safeAccepted = draftDataSchema.safeParse({ accessNotes: "Minta akun uji melalui kanal internal." }).success;
      const kvRejected = !draftDataSchema.safeParse({ accessNotes: "password=contoh-sintetis" }).success;
      const userInfoRejected = !draftDataSchema.safeParse({ accessNotes: "https://user:contoh@fixture.example.invalid/" }).success;
      const passed = safeAccepted && kvRejected && userInfoRejected;
      return {
        status: passed ? "passed" : "failed",
        expected: "Catatan akses nonrahasia diterima; pola kredensial dan URL userinfo ditolak.",
        actual: `safeAccepted=${safeAccepted}, kvRejected=${kvRejected}, userInfoRejected=${userInfoRejected}.`,
      };
    },
  },
  {
    meta: {
      scenarioId: "fixture_empty_cart_assertion_sample",
      title: "Simulasi regresi fungsional keranjang kosong (fixture sintetis gagal)",
      summary: "Skenario fixture sintetis yang sengaja mendeteksi ketidakcocokan pesan keranjang kosong untuk membuktikan pencatatan status failed.",
      fixtureTarget: "in-process://synthetic-cart-fixture",
      defaultCaseKeys: ["FX-FAIL-001", "TC-FIXTURE-FAIL-001"],
      expectedOutcomeHint: "failed",
    },
    run: () => {
      const syntheticCartBanner = "0 items";
      const expectedBanner = "Keranjang belanja kosong";
      const passed = syntheticCartBanner === expectedBanner;
      return {
        status: passed ? "passed" : "failed",
        expected: `Banner fixture menampilkan "${expectedBanner}".`,
        actual: `Banner fixture menampilkan "${syntheticCartBanner}" (tidak sesuai harapan).`,
      };
    },
  },
];

const SCENARIO_BY_ID = new Map<string, ScenarioRunner>(
  SCENARIO_RUNNERS.map(runner => [runner.meta.scenarioId, runner]),
);

const DEFAULT_SCENARIO_BY_CASE_KEY = new Map<string, string>();
for (const runner of SCENARIO_RUNNERS) {
  for (const key of runner.meta.defaultCaseKeys) {
    DEFAULT_SCENARIO_BY_CASE_KEY.set(key.toUpperCase(), runner.meta.scenarioId);
  }
}

export function listApprovedScenarios(): ApprovedScenario[] {
  return SCENARIO_RUNNERS.map(runner => runner.meta);
}

export function getApprovedScenario(scenarioId: string | null | undefined): ApprovedScenario | null {
  if (!scenarioId) return null;
  return SCENARIO_BY_ID.get(scenarioId)?.meta ?? null;
}

export function suggestScenarioForCaseKey(caseKey: string): string | null {
  return DEFAULT_SCENARIO_BY_CASE_KEY.get(caseKey.trim().toUpperCase()) ?? null;
}

export function executeApprovedScenario(
  scenarioId: string | null | undefined,
  skipRequested: boolean,
  referenceExpected: string,
): ScenarioExecutionResult {
  const startMs = Date.now();
  const startedAt = new Date(startMs).toISOString();

  if (skipRequested) {
    const endMs = Date.now();
    const meta = getApprovedScenario(scenarioId);
    return {
      status: "skipped",
      scenarioId: meta?.scenarioId ?? null,
      scenarioTitle: meta?.title ?? "",
      expected: referenceExpected,
      actual: "Dilewati atas pilihan pemilik sebelum eksekusi sesi.",
      blockReason: "",
      durationMs: Math.max(0, endMs - startMs),
      startedAt,
      finishedAt: new Date(endMs).toISOString(),
    };
  }

  const runner = scenarioId ? SCENARIO_BY_ID.get(scenarioId) : undefined;
  if (!runner) {
    const endMs = Date.now();
    return {
      status: "blocked",
      scenarioId: null,
      scenarioTitle: "",
      expected: referenceExpected,
      actual: "Tidak dijalankan karena tidak ada skenario fungsional pradefinisi yang dipetakan.",
      blockReason: "Case CSV hanya data referensi dan belum dipetakan ke skenario fungsional pradefinisi yang disetujui pengembang.",
      durationMs: Math.max(0, endMs - startMs),
      startedAt,
      finishedAt: new Date(endMs).toISOString(),
    };
  }

  try {
    const outcome = runner.run();
    const endMs = Date.now();
    return {
      status: outcome.status,
      scenarioId: runner.meta.scenarioId,
      scenarioTitle: runner.meta.title,
      expected: outcome.expected,
      actual: outcome.actual,
      blockReason: "",
      durationMs: Math.max(0, endMs - startMs),
      startedAt,
      finishedAt: new Date(endMs).toISOString(),
    };
  } catch (error) {
    const endMs = Date.now();
    const detail = error instanceof Error ? error.message : "Kesalahan internal skenario fixture.";
    return {
      status: "failed",
      scenarioId: runner.meta.scenarioId,
      scenarioTitle: runner.meta.title,
      expected: referenceExpected || runner.meta.summary,
      actual: `Eksekusi skenario fixture gagal: ${detail.slice(0, 300)}`,
      blockReason: "",
      durationMs: Math.max(0, endMs - startMs),
      startedAt,
      finishedAt: new Date(endMs).toISOString(),
    };
  }
}

function parseRfc4180Rows(csvText: string): string[][] {
  const text = csvText.replace(/^\uFEFF/u, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some(cell => cell.trim().length > 0)) rows.push(row);
      row = [];
      if (rows.length > MAX_PARSED_ROWS) break;
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.some(cell => cell.trim().length > 0)) rows.push(row);
  }
  return rows;
}

function findColumn(headers: string[], aliases: readonly string[]): number {
  const normalized = headers.map(h => h.trim().toLowerCase().replace(/[\s-]+/g, "_"));
  for (const alias of aliases) {
    const exact = normalized.indexOf(alias);
    if (exact !== -1) return exact;
  }
  for (const alias of aliases) {
    const partial = normalized.findIndex(h => h.includes(alias));
    if (partial !== -1) return partial;
  }
  return -1;
}

function clamp(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

export function parseCsvReferenceCases(csvText: string): CsvReferenceCase[] {
  const rows = parseRfc4180Rows(csvText);
  if (rows.length < 2) return [];
  const headers = rows[0];
  const idIdx = findColumn(headers, ["test_case_id", "tc_id", "case_id", "id", "kode"]);
  const titleIdx = findColumn(headers, ["title", "test_case_title", "test_case", "scenario", "case_name", "name", "summary", "judul"]);
  const expectedIdx = findColumn(headers, ["expected_result", "expected", "hasil_diharapkan", "expected_outcome"]);
  const moduleIdx = findColumn(headers, ["module", "feature", "section", "area", "modul"]);
  const priorityIdx = findColumn(headers, ["priority", "severity", "prioritas"]);

  const seenKeys = new Map<string, number>();
  const cases: CsvReferenceCase[] = [];
  for (let i = 1; i < rows.length && cases.length < MAX_PARSED_ROWS; i++) {
    const cols = rows[i];
    const rawKey = (idIdx >= 0 ? cols[idIdx] : cols[0])?.trim() || `ROW-${i}`;
    const baseKey = clamp(rawKey, 100);
    const seen = seenKeys.get(baseKey) ?? 0;
    seenKeys.set(baseKey, seen + 1);
    const caseKey = seen === 0 ? baseKey : clamp(`${baseKey}#${seen + 1}`, 120);

    const rawTitle = (titleIdx >= 0 ? cols[titleIdx] : cols[1] ?? cols[0])?.trim() || caseKey;
    const rawExpected = (expectedIdx >= 0 ? cols[expectedIdx] : "")?.trim() || "";
    const rawModule = (moduleIdx >= 0 ? cols[moduleIdx] : "")?.trim() || "";
    const rawPriority = (priorityIdx >= 0 ? cols[priorityIdx] : "")?.trim() || "";
    const suggestedScenarioId = suggestScenarioForCaseKey(caseKey);

    cases.push({
      rowIndex: i,
      caseKey,
      title: clamp(rawTitle, 300),
      expected: clamp(rawExpected, 1000),
      module: clamp(rawModule, 120),
      priority: clamp(rawPriority, 60),
      suggestedScenarioId,
      runnableByDefault: suggestedScenarioId !== null,
    });
  }
  return cases;
}
