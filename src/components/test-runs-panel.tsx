"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Deliverable, DeliverableVersion } from "@/contracts/requests";
import {
  createTestRunSchema,
  type ApprovedScenario,
  type CsvReferenceCase,
  type CsvVersionCasesResponse,
  type TestRun,
  type TestRunCaseStatus,
  type TestRunStatus,
} from "@/contracts/test-runs";
import { apiRequest, errorText, HttpError } from "@/components/api-client";
import type { SessionContext } from "@/components/session-gate";
import { StatusChip, formatDateTime, shortId, type Tone } from "@/components/ui";

const runStatusLabel: Record<TestRunStatus, string> = {
  created: "Dibuat",
  running: "Berjalan",
  completed: "Selesai",
  failed: "Gagal",
};

const runStatusTone: Record<TestRunStatus, Tone> = {
  created: "neutral",
  running: "active",
  completed: "done",
  failed: "problem",
};

const caseStatusLabel: Record<TestRunCaseStatus, string> = {
  pending: "Menunggu",
  passed: "Lulus",
  failed: "Gagal",
  blocked: "Terblokir",
  skipped: "Dilewati",
};

const caseStatusTone: Record<TestRunCaseStatus, Tone> = {
  pending: "neutral",
  passed: "done",
  failed: "problem",
  blocked: "info",
  skipped: "neutral",
};

type VersionOption = {
  key: string;
  deliverableId: string;
  version: DeliverableVersion;
};

type CaseDraftSelection = {
  selected: boolean;
  scenarioId: string | null;
  skip: boolean;
};

type RunsListResponse = { runs: TestRun[]; scenarios: ApprovedScenario[] };
type RunResponse = { run: TestRun; replay?: boolean };

function formatDuration(durationMs: number | null | undefined): string {
  if (durationMs === null || durationMs === undefined) return "—";
  if (durationMs < 1000) return `${durationMs} ms`;
  return `${(durationMs / 1000).toFixed(2)} dtk`;
}

function shortHash(sha256: string | null | undefined): string {
  return sha256 ? `${sha256.slice(0, 12)}…` : "—";
}

function makeUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "00000000-0000-4000-8000-000000000000";
}

export default function TestRunsPanel({
  jobId,
  items,
  context,
}: {
  jobId: string;
  items: Deliverable[];
  context: SessionContext;
}) {
  const { signal, onAuthFailure } = context;

  const versionOptions = useMemo<VersionOption[]>(() => {
    const list: VersionOption[] = [];
    for (const item of items) {
      if (item.kind !== "test_case" || item.status !== "ready") continue;
      for (const version of item.versions ?? []) {
        list.push({
          key: `${item.deliverableId}:${version.versionId}`,
          deliverableId: item.deliverableId,
          version,
        });
      }
    }
    return list;
  }, [items]);

  const [selectedOptionKey, setSelectedOptionKey] = useState<string>("");
  const [casesData, setCasesData] = useState<CsvVersionCasesResponse | null>(null);
  const [casesLoading, setCasesLoading] = useState(false);
  const [casesError, setCasesError] = useState("");
  const [selections, setSelections] = useState<Record<string, CaseDraftSelection>>({});
  const [caseQuery, setCaseQuery] = useState("");
  const [mappingFilter, setMappingFilter] = useState<"all" | "mapped" | "unmapped">("all");
  const [sessionNote, setSessionNote] = useState("");

  const [runs, setRuns] = useState<TestRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(true);
  const [runsError, setRunsError] = useState("");
  const [activeRun, setActiveRun] = useState<TestRun | null>(null);
  const [activeRunLoading, setActiveRunLoading] = useState(false);
  const [runCaseFilter, setRunCaseFilter] = useState<"all" | TestRunCaseStatus>("all");

  const [submitting, setSubmitting] = useState(false);
  const [executingRunId, setExecutingRunId] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<{ kind: "info" | "error"; text: string } | null>(null);
  const casesSeq = useRef(0);
  const runDetailSeq = useRef(0);

  useEffect(() => {
    if (versionOptions.length === 0) {
      setSelectedOptionKey("");
      return;
    }
    setSelectedOptionKey(current => {
      if (current && versionOptions.some(option => option.key === current)) return current;
      const preferred = versionOptions.find(option => option.version.isActive) ?? versionOptions[0];
      return preferred.key;
    });
  }, [versionOptions]);

  const selectedOption = useMemo(
    () => versionOptions.find(option => option.key === selectedOptionKey) ?? null,
    [versionOptions, selectedOptionKey],
  );

  const loadRuns = useCallback(async (quiet = false) => {
    if (!quiet) setRunsLoading(true);
    try {
      const result = await apiRequest<RunsListResponse>(`/jobs/${encodeURIComponent(jobId)}/test-runs`, { signal });
      setRuns(result.runs);
      setRunsError("");
    } catch (caught) {
      if (signal.aborted || onAuthFailure(caught)) return;
      setRunsError(errorText(caught));
    } finally {
      if (!quiet) setRunsLoading(false);
    }
  }, [jobId, signal, onAuthFailure]);

  const loadRunDetail = useCallback(async (runId: string) => {
    const seq = ++runDetailSeq.current;
    setActiveRunLoading(true);
    try {
      const result = await apiRequest<RunResponse>(
        `/jobs/${encodeURIComponent(jobId)}/test-runs/${encodeURIComponent(runId)}`,
        { signal },
      );
      if (seq !== runDetailSeq.current) return;
      setActiveRun(result.run);
      setRunCaseFilter("all");
    } catch (caught) {
      if (seq !== runDetailSeq.current || signal.aborted || onAuthFailure(caught)) return;
      setActionNotice({ kind: "error", text: `Detail sesi belum dapat dimuat. ${errorText(caught)}` });
    } finally {
      if (seq === runDetailSeq.current) setActiveRunLoading(false);
    }
  }, [jobId, signal, onAuthFailure]);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  useEffect(() => {
    if (!selectedOption) {
      setCasesData(null);
      setSelections({});
      return;
    }
    const seq = ++casesSeq.current;
    setCasesLoading(true);
    setCasesError("");
    const path = `/jobs/${encodeURIComponent(jobId)}/deliverables/${encodeURIComponent(selectedOption.deliverableId)}/versions/${encodeURIComponent(selectedOption.version.versionId)}/cases`;
    apiRequest<CsvVersionCasesResponse>(path, { signal })
      .then(data => {
        if (seq !== casesSeq.current) return;
        setCasesData(data);
        const initial: Record<string, CaseDraftSelection> = {};
        let autoSelected = 0;
        for (const item of data.cases) {
          const defaultPick = item.runnableByDefault && autoSelected < 200;
          if (defaultPick) autoSelected++;
          initial[item.caseKey] = {
            selected: defaultPick,
            scenarioId: item.suggestedScenarioId,
            skip: false,
          };
        }
        setSelections(initial);
      })
      .catch(caught => {
        if (seq !== casesSeq.current || signal.aborted || onAuthFailure(caught)) return;
        setCasesData(null);
        setSelections({});
        setCasesError(errorText(caught));
      })
      .finally(() => {
        if (seq === casesSeq.current) setCasesLoading(false);
      });
  }, [jobId, selectedOption, signal, onAuthFailure]);

  const cases = casesData?.cases ?? [];
  const scenarios = casesData?.scenarios ?? [];

  const filteredCases = useMemo(() => {
    const q = caseQuery.trim().toLowerCase();
    return cases.filter(item => {
      const draft = selections[item.caseKey];
      const hasMapping = Boolean(draft ? draft.scenarioId : item.suggestedScenarioId);
      if (mappingFilter === "mapped" && !hasMapping) return false;
      if (mappingFilter === "unmapped" && hasMapping) return false;
      if (!q) return true;
      return (
        item.caseKey.toLowerCase().includes(q) ||
        item.title.toLowerCase().includes(q) ||
        item.module.toLowerCase().includes(q)
      );
    });
  }, [cases, selections, caseQuery, mappingFilter]);

  const selectedList = useMemo(() => {
    return cases
      .filter(item => selections[item.caseKey]?.selected)
      .map(item => ({
        caseKey: item.caseKey,
        scenarioId: selections[item.caseKey]?.scenarioId ?? null,
        skip: selections[item.caseKey]?.skip ?? false,
      }));
  }, [cases, selections]);

  const selectedMappedCount = selectedList.filter(item => !item.skip && item.scenarioId !== null).length;
  const selectedBlockedCount = selectedList.filter(item => !item.skip && item.scenarioId === null).length;
  const selectedSkippedCount = selectedList.filter(item => item.skip).length;

  function selectAllMapped() {
    setSelections(current => {
      const next = { ...current };
      let count = 0;
      for (const item of cases) {
        const existing = next[item.caseKey] ?? { selected: false, scenarioId: item.suggestedScenarioId, skip: false };
        const shouldSelect = existing.scenarioId !== null && count < 200;
        if (shouldSelect) count++;
        next[item.caseKey] = { ...existing, selected: shouldSelect };
      }
      return next;
    });
  }

  function selectAllCases() {
    setSelections(current => {
      const next = { ...current };
      let count = 0;
      for (const item of cases) {
        const existing = next[item.caseKey] ?? { selected: false, scenarioId: item.suggestedScenarioId, skip: false };
        const shouldSelect = count < 200;
        if (shouldSelect) count++;
        next[item.caseKey] = { ...existing, selected: shouldSelect };
      }
      return next;
    });
  }

  function clearSelection() {
    setSelections(current => {
      const next = { ...current };
      for (const key of Object.keys(next)) {
        next[key] = { ...next[key], selected: false };
      }
      return next;
    });
  }

  function toggleCase(caseKey: string) {
    setSelections(current => {
      const existing = current[caseKey];
      if (!existing) return current;
      if (!existing.selected && selectedList.length >= 200) {
        setActionNotice({ kind: "error", text: "Maksimal 200 test case dalam satu sesi pengujian." });
        return current;
      }
      return { ...current, [caseKey]: { ...existing, selected: !existing.selected } };
    });
  }

  function updateScenario(caseKey: string, scenarioId: string) {
    setSelections(current => {
      const existing = current[caseKey];
      if (!existing) return current;
      return { ...current, [caseKey]: { ...existing, scenarioId: scenarioId || null } };
    });
  }

  function toggleSkip(caseKey: string) {
    setSelections(current => {
      const existing = current[caseKey];
      if (!existing) return current;
      return { ...current, [caseKey]: { ...existing, skip: !existing.skip } };
    });
  }

  async function createAndExecuteRun() {
    if (!selectedOption || submitting || executingRunId) return;
    const payload = {
      deliverableId: selectedOption.deliverableId,
      versionId: selectedOption.version.versionId,
      note: sessionNote.trim(),
      selectedCases: selectedList,
    };
    const parsed = createTestRunSchema.safeParse(payload);
    if (!parsed.success) {
      setActionNotice({ kind: "error", text: "Pilih minimal 1 test case (maksimal 200) sebelum menjalankan sesi." });
      return;
    }

    setSubmitting(true);
    setActionNotice(null);
    let createdRun: TestRun | null = null;
    try {
      const created = await apiRequest<RunResponse>(`/jobs/${encodeURIComponent(jobId)}/test-runs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": makeUuid(),
        },
        body: JSON.stringify(parsed.data),
        signal,
      });
      createdRun = created.run;
      setActiveRun(created.run);
      setRunCaseFilter("all");
      setSessionNote("");

      const executed = await apiRequest<RunResponse>(
        `/jobs/${encodeURIComponent(jobId)}/test-runs/${encodeURIComponent(created.run.runId)}/execute`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          signal,
        },
      );
      setActiveRun(executed.run);
      setActionNotice({
        kind: "info",
        text: `Sesi fixture #${shortId(executed.run.runId)} selesai dijalankan (${executed.run.counts.passed} lulus, ${executed.run.counts.failed} gagal, ${executed.run.counts.blocked} terblokir, ${executed.run.counts.skipped} dilewati).`,
      });
      void loadRuns(true);
    } catch (caught) {
      if (signal.aborted || onAuthFailure(caught)) return;
      if (createdRun) {
        setActionNotice({
          kind: "error",
          text: `Sesi #${shortId(createdRun.runId)} sudah dibuat, tetapi eksekusi fixture gagal: ${errorText(caught)} Kamu bisa klik "Jalankan sesi" di histori untuk mencoba lagi.`,
        });
        void loadRuns(true);
      } else {
        setActionNotice({
          kind: "error",
          text: caught instanceof HttpError && caught.status === 409
            ? `Konflik sesi pengujian. ${errorText(caught)}`
            : `Sesi pengujian belum dapat dibuat. ${errorText(caught)}`,
        });
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function executeExistingRun(runId: string) {
    if (executingRunId || submitting) return;
    setExecutingRunId(runId);
    setActionNotice(null);
    try {
      const result = await apiRequest<RunResponse>(
        `/jobs/${encodeURIComponent(jobId)}/test-runs/${encodeURIComponent(runId)}/execute`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          signal,
        },
      );
      setActiveRun(result.run);
      setRunCaseFilter("all");
      setActionNotice({
        kind: "info",
        text: result.replay
          ? `Sesi fixture #${shortId(result.run.runId)} sudah selesai sebelumnya; hasil dimuat kembali.`
          : `Sesi fixture #${shortId(result.run.runId)} selesai dijalankan.`,
      });
      void loadRuns(true);
    } catch (caught) {
      if (signal.aborted || onAuthFailure(caught)) return;
      setActionNotice({ kind: "error", text: `Eksekusi sesi gagal. ${errorText(caught)}` });
      void loadRuns(true);
    } finally {
      setExecutingRunId(null);
    }
  }

  if (versionOptions.length === 0 && runs.length === 0 && !runsLoading) {
    return null;
  }

  const inspectedCases = activeRun?.cases ?? [];
  const visibleRunCases = runCaseFilter === "all"
    ? inspectedCases
    : inspectedCases.filter(item => item.status === runCaseFilter);

  return (
    <section className="panel test-runs-panel" aria-labelledby="test-runs-title">
      <div className="panel-head">
        <div>
          <p className="eyebrow">SESI PENGUJIAN TERPISAH</p>
          <h2 id="test-runs-title">Otomasi fungsional terbatas (fixture sintetis)</h2>
          <p className="panel-lede">
            Pilih versi CSV immutable dan test case yang memiliki mapping ke skenario fixture pradefinisi, lalu jalankan secara eksplisit.
          </p>
        </div>
        <span className="fixture-pill" title="Dijalankan in-process pada fixture sintetis proyek, bukan situs target asli">
          Fixture sintetis · Bukan tes target asli
        </span>
      </div>

      <div className="banner banner-warn fixture-banner" role="note">
        <strong>Lingkungan fixture sintetis (bukan pengujian situs target asli).</strong>
        <p>
          File CSV dibaca murni sebagai data referensi dan tidak mengeksekusi script atau URL dari CSV. Hanya skenario fungsional pradefinisi milik proyek (<span className="mono">*.example.invalid</span>) yang dijalankan; case tanpa mapping akan tercatat <strong>Terblokir</strong> beserta alasannya. Artefak draft, riwayat versi, dan status job tetap terpisah.
        </p>
      </div>

      {actionNotice && (
        <div
          className={`banner banner-${actionNotice.kind === "error" ? "error" : "info"}`}
          role={actionNotice.kind === "error" ? "alert" : "status"}
        >
          {actionNotice.text}
        </div>
      )}

      {versionOptions.length > 0 && (
        <div className="test-runner-builder">
          <div className="runner-controls">
            <div className="field">
              <label className="field-label" htmlFor="test-run-csv-version">Versi CSV Test Case</label>
              <select
                id="test-run-csv-version"
                className="input select"
                value={selectedOptionKey}
                onChange={event => setSelectedOptionKey(event.target.value)}
                disabled={submitting}
              >
                {versionOptions.map(option => (
                  <option key={option.key} value={option.key}>
                    v{option.version.versionNumber} · {option.version.fileName} ({option.version.isActive ? "Aktif" : "Versi lama"} · {option.version.documentStatus === "final" ? "Final" : "Draft"})
                  </option>
                ))}
              </select>
              {casesData && (
                <p className="help">
                  {cases.length} case referensi · SHA-256 <span className="mono">{shortHash(casesData.fileSha256)}</span> · {scenarios.length} skenario fixture pradefinisi tersedia.
                </p>
              )}
            </div>

            <div className="field">
              <label className="field-label" htmlFor="test-run-note">Catatan sesi (opsional)</label>
              <input
                id="test-run-note"
                className="input"
                type="text"
                maxLength={500}
                value={sessionNote}
                onChange={event => setSessionNote(event.target.value)}
                placeholder="Contoh: cek skenario pradefinisi untuk revisi v2"
                disabled={submitting}
              />
            </div>
          </div>

          {casesLoading && <p className="empty-inline" role="status">Memuat daftar test case dari versi CSV…</p>}
          {casesError && <p className="banner banner-error" role="alert">Daftar test case belum dapat dimuat. {casesError}</p>}

          {!casesLoading && !casesError && casesData && (
            <>
              <div className="case-toolbar">
                <div className="case-toolbar-search">
                  <label className="visually-hidden" htmlFor="case-search">Cari test case</label>
                  <input
                    id="case-search"
                    className="input"
                    type="search"
                    value={caseQuery}
                    onChange={event => setCaseQuery(event.target.value)}
                    placeholder="Cari kode, judul, atau modul…"
                  />
                  <label className="visually-hidden" htmlFor="case-mapping-filter">Filter mapping</label>
                  <select
                    id="case-mapping-filter"
                    className="input select case-filter-select"
                    value={mappingFilter}
                    onChange={event => setMappingFilter(event.target.value as "all" | "mapped" | "unmapped")}
                  >
                    <option value="all">Semua case ({cases.length})</option>
                    <option value="mapped">Punya mapping</option>
                    <option value="unmapped">Tanpa mapping</option>
                  </select>
                </div>
                <div className="case-toolbar-actions">
                  <button type="button" className="button button-quiet" onClick={selectAllMapped} disabled={submitting}>
                    Pilih yang terpetakan
                  </button>
                  <button type="button" className="button button-quiet" onClick={selectAllCases} disabled={submitting}>
                    Pilih semua
                  </button>
                  <button type="button" className="button button-quiet" onClick={clearSelection} disabled={submitting}>
                    Kosongkan
                  </button>
                </div>
              </div>

              {filteredCases.length === 0 ? (
                <p className="empty-inline">Tidak ada test case yang cocok dengan filter.</p>
              ) : (
                <ul className="case-picker-list" aria-label="Daftar test case referensi">
                  {filteredCases.map((item: CsvReferenceCase) => {
                    const draft = selections[item.caseKey] ?? {
                      selected: false,
                      scenarioId: item.suggestedScenarioId,
                      skip: false,
                    };
                    const unmapped = !draft.scenarioId;
                    return (
                      <li className="case-picker-row" key={item.caseKey} data-selected={draft.selected ? "true" : undefined}>
                        <div className="case-picker-main">
                          <label className="check case-picker-check">
                            <input
                              type="checkbox"
                              checked={draft.selected}
                              onChange={() => toggleCase(item.caseKey)}
                              disabled={submitting}
                            />
                            <span>
                              <strong className="mono">{item.caseKey}</strong> — {item.title}
                            </span>
                          </label>
                          <p className="case-picker-meta">
                            {item.module && <span>Modul: {item.module} · </span>}
                            {item.priority && <span>Prioritas: {item.priority} · </span>}
                            <span>Harapan referensi: {item.expected || "—"}</span>
                          </p>
                          {unmapped && !draft.skip && (
                            <p className="case-unmapped-reason">
                              Belum ada mapping ke skenario fixture pradefinisi — jika dipilih, case ini akan tercatat <strong>Terblokir</strong>.
                            </p>
                          )}
                        </div>

                        <div className="case-picker-controls">
                          <label className="visually-hidden" htmlFor={`scenario-${item.caseKey}`}>
                            Skenario fixture untuk {item.caseKey}
                          </label>
                          <select
                            id={`scenario-${item.caseKey}`}
                            className="input select scenario-select"
                            value={draft.scenarioId ?? ""}
                            onChange={event => updateScenario(item.caseKey, event.target.value)}
                            disabled={submitting || draft.skip}
                          >
                            <option value="">Tanpa mapping (Terblokir)</option>
                            {scenarios.map(scenario => (
                              <option key={scenario.scenarioId} value={scenario.scenarioId}>
                                {scenario.title} ({scenario.expectedOutcomeHint === "failed" ? "sampel gagal" : "fixture"})
                              </option>
                            ))}
                          </select>
                          <label className="check case-skip-check">
                            <input
                              type="checkbox"
                              checked={draft.skip}
                              onChange={() => toggleSkip(item.caseKey)}
                              disabled={submitting || !draft.selected}
                            />
                            <span>Lewati</span>
                          </label>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}

              <div className="runner-submit-bar">
                <p className="help">
                  Terpilih <strong>{selectedList.length}</strong> case ({selectedMappedCount} terpetakan, {selectedBlockedCount} tanpa mapping → Terblokir, {selectedSkippedCount} dilewati). Maksimal 200 case per sesi.
                </p>
                <button
                  type="button"
                  className="button button-primary"
                  disabled={submitting || executingRunId !== null || selectedList.length === 0}
                  onClick={() => void createAndExecuteRun()}
                >
                  {submitting ? "Menjalankan sesi fixture…" : "Buat & jalankan sesi uji (fixture)"}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      <div className="runs-history-block">
        <div className="runs-history-head">
          <h3>Histori sesi pengujian ({runs.length})</h3>
          <button type="button" className="link-button" onClick={() => void loadRuns()} disabled={runsLoading}>
            {runsLoading ? "Memuat…" : "Muat ulang histori"}
          </button>
        </div>

        {runsError && <p className="banner banner-error" role="alert">Histori sesi belum dapat dimuat. {runsError}</p>}

        {!runsLoading && !runsError && runs.length === 0 && (
          <p className="empty-inline">Belum ada sesi pengujian fungsional terbatas untuk permintaan ini.</p>
        )}

        {runs.length > 0 && (
          <ul className="runs-list">
            {runs.map(run => {
              const isSelected = activeRun?.runId === run.runId;
              return (
                <li className="run-row" key={run.runId} data-selected={isSelected ? "true" : undefined}>
                  <div className="run-row-main">
                    <div className="run-row-title">
                      <strong className="mono">#{shortId(run.runId)}</strong>
                      <StatusChip tone={runStatusTone[run.status]}>{runStatusLabel[run.status]}</StatusChip>
                      <span className="artifact-badge artifact-badge-version mono">v{run.versionNumber}</span>
                      <span className="artifact-badge artifact-badge-draft">Fixture sintetis</span>
                    </div>
                    <p className="run-row-meta">
                      {run.fileName} · dibuat {formatDateTime(run.createdAt)}
                      {run.finishedAt && <> · selesai {formatDateTime(run.finishedAt)}</>}
                    </p>
                    {run.note && <p className="run-row-note">{run.note}</p>}
                    <div className="run-counts">
                      <span className="count-pill count-passed">Lulus: {run.counts.passed}</span>
                      <span className="count-pill count-failed">Gagal: {run.counts.failed}</span>
                      <span className="count-pill count-blocked">Terblokir: {run.counts.blocked}</span>
                      <span className="count-pill count-skipped">Dilewati: {run.counts.skipped}</span>
                      <span className="count-pill count-total">Total: {run.counts.total}</span>
                    </div>
                  </div>
                  <div className="run-row-actions">
                    {run.status === "created" && (
                      <button
                        type="button"
                        className="button button-primary"
                        disabled={executingRunId !== null || submitting}
                        onClick={() => void executeExistingRun(run.runId)}
                      >
                        {executingRunId === run.runId ? "Menjalankan…" : "Jalankan sesi"}
                      </button>
                    )}
                    <button
                      type="button"
                      className="button button-quiet"
                      disabled={activeRunLoading}
                      onClick={() => void loadRunDetail(run.runId)}
                    >
                      {isSelected ? "Sedang dibuka" : "Lihat detail"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {activeRunLoading && <p className="empty-inline" role="status">Memuat rincian hasil per case…</p>}

      {activeRun && !activeRunLoading && (
        <div className="run-detail-block" role="region" aria-label={`Detail sesi #${shortId(activeRun.runId)}`}>
          <div className="run-detail-head">
            <div>
              <div className="run-row-title">
                <h3>Detail sesi <span className="mono">#{shortId(activeRun.runId)}</span></h3>
                <StatusChip tone={runStatusTone[activeRun.status]}>{runStatusLabel[activeRun.status]}</StatusChip>
                <span className="artifact-badge artifact-badge-draft">Hasil fixture sintetis · Bukan target asli</span>
              </div>
              <p className="run-row-meta">
                Sumber CSV: <strong>v{activeRun.versionNumber}</strong> ({activeRun.fileName} · SHA-256 <span className="mono">{shortHash(activeRun.fileSha256)}</span>)
                {" · "}Mulai: {formatDateTime(activeRun.startedAt)} · Selesai: {formatDateTime(activeRun.finishedAt)}
              </p>
            </div>
            <button type="button" className="link-button" onClick={() => setActiveRun(null)}>
              Tutup detail
            </button>
          </div>

          <div className="run-counts run-detail-filters" role="group" aria-label="Filter status hasil case">
            {([
              ["all", `Semua (${activeRun.counts.total})`],
              ["passed", `Lulus (${activeRun.counts.passed})`],
              ["failed", `Gagal (${activeRun.counts.failed})`],
              ["blocked", `Terblokir (${activeRun.counts.blocked})`],
              ["skipped", `Dilewati (${activeRun.counts.skipped})`],
            ] as const).map(([statusKey, label]) => (
              <button
                key={statusKey}
                type="button"
                className={`count-filter ${runCaseFilter === statusKey ? "is-active" : ""}`}
                onClick={() => setRunCaseFilter(statusKey)}
              >
                {label}
              </button>
            ))}
          </div>

          {visibleRunCases.length === 0 ? (
            <p className="empty-inline">Tidak ada case dengan status ini pada sesi tersebut.</p>
          ) : (
            <ol className="run-cases-list">
              {visibleRunCases.map(item => (
                <li className="run-case-card" key={item.runCaseId} data-status={item.status}>
                  <div className="run-case-head">
                    <div className="run-row-title">
                      <strong className="mono">{item.caseKey}</strong>
                      <span>{item.caseTitle}</span>
                      <StatusChip tone={caseStatusTone[item.status]}>{caseStatusLabel[item.status]}</StatusChip>
                    </div>
                    <span className="run-case-time mono">
                      {formatDuration(item.durationMs)}
                    </span>
                  </div>

                  <p className="run-case-scenario">
                    Skenario fixture:{" "}
                    {item.scenarioId
                      ? <><strong className="mono">{item.scenarioId}</strong> ({item.scenarioTitle})</>
                      : <span>Tanpa mapping skenario pradefinisi</span>}
                    {item.startedAt && <> · Mulai {formatDateTime(item.startedAt)}</>}
                    {item.finishedAt && <> · Selesai {formatDateTime(item.finishedAt)}</>}
                  </p>

                  <dl className="run-case-dl">
                    <div>
                      <dt>Expected</dt>
                      <dd className="preserve-lines">{item.expected || item.referenceExpected || "—"}</dd>
                    </div>
                    <div>
                      <dt>Actual</dt>
                      <dd className="preserve-lines">{item.actual || "—"}</dd>
                    </div>
                    {item.blockReason && (
                      <div>
                        <dt>Alasan terblokir</dt>
                        <dd className="preserve-lines run-case-block-reason">{item.blockReason}</dd>
                      </div>
                    )}
                  </dl>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}
