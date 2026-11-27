"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  canReconcile, isTerminal,
  type Job, type JobResponse,
} from "@/contracts";
import {
  deliverableCatalog,
  type Deliverable, type DeliverableVersion, type DocumentStatus, type RevisionGrant, type Submission,
} from "@/contracts/requests";
import { apiRequest, downloadDeliverable, errorText, HttpError } from "@/components/api-client";
import type { SessionContext } from "@/components/session-gate";
import { StatusChip, formatBytes, formatDateTime, shortId, type Tone } from "@/components/ui";

const deliveryLabel: Record<Job["deliveryStatus"], string> = {
  not_sent: "Belum dikirim",
  sending: "Mengirim ke QA",
  accepted: "Diterima agent QA",
  failed: "Pengiriman gagal",
  unknown: "Pengiriman belum pasti",
};
const deliveryTone: Record<Job["deliveryStatus"], Tone> = {
  not_sent: "neutral", sending: "info", accepted: "info", failed: "problem", unknown: "problem",
};
const executionLabel: Record<Job["executionStatus"], string> = {
  not_started: "Belum dimulai", running: "Sedang diuji", succeeded: "Selesai", failed: "Pengujian gagal",
};
const executionTone: Record<Job["executionStatus"], Tone> = {
  not_started: "neutral", running: "active", succeeded: "done", failed: "problem",
};
const environmentLabel: Record<Submission["environment"], string> = {
  development: "Development", staging: "Staging", production: "Production", other: "Lainnya",
};
const itemTone: Record<Deliverable["status"], Tone> = { pending: "neutral", ready: "done", failed: "problem" };
const itemLabel: Record<Deliverable["status"], string> = { pending: "Menunggu", ready: "Siap diunduh", failed: "Gagal" };
const documentStatusLabel: Record<DocumentStatus, string> = { draft: "Draft", final: "Final" };
const outcomeLabel = { pass: "Sesuai", fail: "Tidak sesuai", blocked: "Terhalang" } as const;

type Progress = { request: Submission | null; items: Deliverable[]; ready: number; total: number; partial: boolean };
type Action = "dispatch" | "retry" | "reconcile";
type GrantResponse = { grant: RevisionGrant };

function safeApiDownloadPath(candidate: string | null | undefined, fallback: string): string {
  if (candidate && candidate.startsWith("/api/v1/") && !candidate.startsWith("//")) return candidate;
  return fallback;
}

function shortChecksum(sha256: string | null | undefined): string | null {
  if (!sha256) return null;
  return `${sha256.slice(0, 12)}…`;
}

export default function JobDetail({ jobId, context }: { jobId: string; context: SessionContext }) {
  const { signal, onAuthFailure } = context;

  const [job, setJob] = useState<Job | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing" | "error">("loading");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<{ kind: "info" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState<Action | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState("");
  const [expandedHistory, setExpandedHistory] = useState<Record<string, boolean>>({});
  const [issuingGrant, setIssuingGrant] = useState<string | null>(null);
  const [grants, setGrants] = useState<Record<string, RevisionGrant>>({});
  const [grantErrors, setGrantErrors] = useState<Record<string, string>>({});
  const [revealedTokens, setRevealedTokens] = useState<Record<string, boolean>>({});
  const [copyFeedback, setCopyFeedback] = useState<Record<string, string>>({});
  const [stale, setStale] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async (quiet = false) => {
    const current = ++seq.current;
    if (!quiet) setState("loading");
    try {
      const [jobResult, progressResult] = await Promise.all([
        apiRequest<JobResponse>(`/jobs/${encodeURIComponent(jobId)}`, { signal }),
        apiRequest<Progress>(`/jobs/${encodeURIComponent(jobId)}/deliverables`, { signal }),
      ]);
      if (current !== seq.current) return;
      setJob(jobResult.job);
      setProgress(progressResult);
      setStale(false);
      setState("ready");
      setError("");
    } catch (caught) {
      if (current !== seq.current) return;
      if (signal.aborted || onAuthFailure(caught)) return;
      if (caught instanceof HttpError && caught.status === 404) {
        setState("missing");
        return;
      }
      setError(errorText(caught));
      if (!quiet) setState("error");
      else setStale(true);
    }
  }, [jobId, signal, onAuthFailure]);

  useEffect(() => { void load(); return () => { seq.current++; }; }, [load]);

  useEffect(() => {
    if (!job || isTerminal(job)) return;
    const watch = job.deliveryStatus === "sending" || job.deliveryStatus === "accepted" || job.executionStatus === "running";
    if (!watch) return;
    const timer = window.setInterval(() => { void load(true); }, 5000);
    return () => window.clearInterval(timer);
  }, [job, load]);

  async function act(action: Action) {
    if (!job || busy) return;
    setBusy(action);
    setNotice(null);
    try {
      const result = await callJobAction(job.jobId, action);
      setJob(result.job);
      setStale(false);
      setNotice({ kind: "info", text: action === "dispatch" ? "Permintaan dikirim ke agent QA." : "Status diperbarui." });
      void load(true);
    } catch (caught) {
      if (signal.aborted || onAuthFailure(caught)) return;
      setStale(true);
      setNotice({
        kind: "error",
        text: caught instanceof HttpError && caught.status === 409
          ? `Status berubah atau tindakan tidak diizinkan. ${errorText(caught)}`
          : `Hasil tindakan belum dapat dipastikan. ${errorText(caught)} Status dimuat ulang tanpa mengulang pengiriman.`,
      });
      void load(true);
    } finally {
      setBusy(null);
    }
  }

  async function downloadItem(item: Deliverable) {
    if (downloading || !item.fileName) return;
    const fallback = `/api/v1/jobs/${encodeURIComponent(jobId)}/deliverables/${encodeURIComponent(item.deliverableId)}`;
    const path = safeApiDownloadPath(item.downloadUrl, fallback);
    setDownloading(item.deliverableId);
    setDownloadError("");
    try {
      await downloadDeliverable(path, item.fileName, signal);
    } catch (caught) {
      if (!signal.aborted && !onAuthFailure(caught)) setDownloadError(errorText(caught));
    } finally {
      setDownloading(null);
    }
  }

  async function downloadVersion(item: Deliverable, version: DeliverableVersion) {
    if (downloading || !version.fileName) return;
    const fallback = `/api/v1/jobs/${encodeURIComponent(jobId)}/deliverables/${encodeURIComponent(item.deliverableId)}/versions/${encodeURIComponent(version.versionId)}`;
    const path = safeApiDownloadPath(version.downloadUrl, fallback);
    const key = `version:${version.versionId}`;
    setDownloading(key);
    setDownloadError("");
    try {
      await downloadDeliverable(path, version.fileName, signal);
    } catch (caught) {
      if (!signal.aborted && !onAuthFailure(caught)) setDownloadError(errorText(caught));
    } finally {
      setDownloading(null);
    }
  }

  async function issueRevisionGrant(item: Deliverable) {
    if (issuingGrant || item.status !== "ready") return;
    setIssuingGrant(item.deliverableId);
    setGrantErrors(current => {
      const next = { ...current };
      delete next[item.deliverableId];
      return next;
    });
    try {
      const result = await apiRequest<GrantResponse>(
        `/jobs/${encodeURIComponent(jobId)}/deliverables/${encodeURIComponent(item.deliverableId)}/revision-grants`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          signal,
        },
      );
      setGrants(current => ({ ...current, [item.deliverableId]: result.grant }));
      setRevealedTokens(current => ({ ...current, [item.deliverableId]: false }));
      setCopyFeedback(current => {
        const next = { ...current };
        delete next[item.deliverableId];
        return next;
      });
    } catch (caught) {
      if (signal.aborted || onAuthFailure(caught)) return;
      setGrantErrors(current => ({ ...current, [item.deliverableId]: errorText(caught) }));
    } finally {
      setIssuingGrant(null);
    }
  }

  function dismissGrant(deliverableId: string) {
    setGrants(current => {
      const next = { ...current };
      delete next[deliverableId];
      return next;
    });
    setRevealedTokens(current => {
      const next = { ...current };
      delete next[deliverableId];
      return next;
    });
    setCopyFeedback(current => {
      const next = { ...current };
      delete next[deliverableId];
      return next;
    });
  }

  async function copyGrantField(deliverableId: string, label: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopyFeedback(current => ({ ...current, [deliverableId]: `${label} disalin ke papan klip.` }));
    } catch {
      setCopyFeedback(current => ({ ...current, [deliverableId]: `Salin otomatis tidak tersedia; salin ${label.toLowerCase()} secara manual.` }));
    }
  }

  if (state === "loading") return <main className="shell"><p className="empty" role="status">Memuat permintaan…</p></main>;

  if (state === "missing") return <main className="shell">
    <section className="panel auth-panel" aria-labelledby="missing-title">
      <p className="eyebrow">PERMINTAAN</p>
      <h1 id="missing-title">Permintaan tidak ditemukan</h1>
      <p className="auth-description">Permintaan ini tidak tersedia untuk akunmu, atau tautannya salah. Hasil hanya bisa dibuka oleh pemilik akun.</p>
      <div className="actions"><Link className="button button-primary" href="/">Kembali ke daftar</Link></div>
    </section>
  </main>;

  if (state === "error" || !job) return <main className="shell">
    <section className="panel auth-panel" aria-labelledby="error-title">
      <p className="eyebrow">PERMINTAAN</p>
      <h1 id="error-title">Permintaan belum dapat dimuat</h1>
      <p className="auth-description">{error}</p>
      <div className="actions"><button type="button" className="button button-primary" onClick={() => void load()}>Coba lagi</button><Link className="button button-quiet" href="/">Kembali ke daftar</Link></div>
    </section>
  </main>;

  const request = progress?.request ?? null;
  const items = progress?.items ?? [];
  const ready = progress?.ready ?? 0;
  const total = progress?.total ?? 0;
  const legacy = items.length === 0;
  const leaseActive = job.leaseExpiresAt !== null && Date.parse(job.leaseExpiresAt) > Date.now();
  const canRetry = !isTerminal(job) && !leaseActive &&
    (job.deliveryStatus === "failed" || job.deliveryStatus === "unknown" || job.deliveryStatus === "sending");
  const canReconcileNow = canReconcile(job);

  return <main className="shell">
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">QA</span>
        <span className="brand-text"><strong>Detail permintaan</strong><span className="mono">#{shortId(job.jobId)}</span></span>
      </div>
      <div className="topbar-account"><Link className="link-button" href="/">Kembali ke daftar</Link></div>
    </header>

    {notice && <div className={`banner banner-${notice.kind === "error" ? "error" : "info"}`} role={notice.kind === "error" ? "alert" : "status"}>{notice.text}</div>}
    {stale && <div className="banner banner-warn" role="status">Data mungkin sudah berubah. <button type="button" className="link-button" onClick={() => void load()}>Muat ulang</button></div>}

    <section className="panel detail-hero" aria-labelledby="detail-title">
      <div>
        <p className="eyebrow">PERMINTAAN QA</p>
        <h1 id="detail-title" className="detail-url">{job.targetUrl}</h1>
        <p className="page-lede">Dibuat {formatDateTime(job.createdAt)} · diperbarui {formatDateTime(job.updatedAt)}</p>
      </div>
      <div className="status-stack">
        <div className="status-line"><span>Pengiriman</span><StatusChip tone={stale ? "problem" : deliveryTone[job.deliveryStatus]}>{stale ? "Belum terverifikasi" : deliveryLabel[job.deliveryStatus]}</StatusChip></div>
        <div className="status-line"><span>Eksekusi</span><StatusChip tone={stale ? "problem" : executionTone[job.executionStatus]}>{stale ? "Belum terverifikasi" : executionLabel[job.executionStatus]}</StatusChip></div>
      </div>
    </section>

    {job.lastError && <div className="banner banner-error" role="alert"><strong>Kesalahan terakhir</strong><p>{job.lastError.message} <span className="mono">({job.lastError.code})</span></p></div>}

    {job.deliveryStatus === "not_sent" && <section className="panel next-step" aria-labelledby="next-step-title">
      <div>
        <h2 id="next-step-title">Langkah berikutnya: kirim ke agent QA</h2>
        <p className="panel-lede">Permintaan sudah tersimpan dan dibekukan. Setelah dikirim, agent QA mulai mengerjakan {total > 0 ? `${total} deliverable` : "deliverable"} yang diminta.</p>
      </div>
      <button type="button" className="button button-primary" onClick={() => void act("dispatch")} disabled={busy !== null || stale}>
        {busy === "dispatch" ? "Mengirim…" : "Kirim ke QA"}
      </button>
    </section>}

    <div className="detail-grid">
      <section className="panel" aria-labelledby="results-title">
        <div className="panel-head">
          <div>
            <h2 id="results-title">Hasil per deliverable</h2>
            <p className="panel-lede">{
              total > 0
                ? job.deliveryStatus === "not_sent"
                  ? `${total} deliverable menunggu dikirim ke agent QA`
                  : `${ready} dari ${total} hasil tersedia`
                : legacy
                  ? "Permintaan ini tidak memiliki daftar file deliverable."
                  : "Daftar hasil belum tersedia."
            }</p>
          </div>
          {total > 0 && <div className="meter" role="img" aria-label={`${ready} dari ${total} hasil siap diunduh`}>
            <span style={{ width: `${total === 0 ? 0 : Math.round((ready / total) * 100)}%` }} />
          </div>}
        </div>

        {downloadError && <p className="banner banner-error" role="alert">{downloadError}</p>}
        {progress?.partial && <p className="banner banner-warn">Eksekusi sudah berakhir, tetapi hanya sebagian hasil tersedia. File yang siap tetap bisa diunduh.</p>}

        {total > 0 && <ul className="artifact-list">
          {items.map(item => {
            const versions = item.versions ?? [];
            const olderVersions = versions.filter(version => !version.isActive);
            const activeVersion = versions.find(version => version.isActive) ?? null;
            const activeVersionNumber = item.activeVersionNumber ?? activeVersion?.versionNumber ?? null;
            const docStatus = item.documentStatus ?? activeVersion?.documentStatus ?? null;
            const historyOpen = expandedHistory[item.deliverableId] ?? olderVersions.length > 0;
            const grant = grants[item.deliverableId] ?? null;
            const grantError = grantErrors[item.deliverableId] ?? "";
            const tokenVisible = revealedTokens[item.deliverableId] ?? false;
            const activeChecksum = shortChecksum(item.sha256);

            return <li className="artifact" key={item.deliverableId} data-status={item.status}>
              <div className="artifact-top">
                <div className="artifact-main">
                  <div className="artifact-title">
                    <strong>{deliverableCatalog[item.kind].label}</strong>
                    <StatusChip tone={itemTone[item.status]}>{itemLabel[item.status]}</StatusChip>
                    {item.status === "ready" && activeVersionNumber !== null && (
                      <span className="artifact-badge artifact-badge-version mono">v{activeVersionNumber} aktif</span>
                    )}
                    {item.status === "ready" && docStatus && (
                      <span
                        className={`artifact-badge artifact-badge-${docStatus}`}
                        title="Status dokumen ini terpisah dari status eksekusi job"
                      >
                        {documentStatusLabel[docStatus]}
                      </span>
                    )}
                  </div>
                  <p className="artifact-meta">
                    {item.status === "ready"
                      ? <>
                        {item.fileName} · {formatBytes(item.sizeBytes)} · {formatDateTime(item.readyAt)}
                        {activeChecksum && <> · <span className="mono">SHA-256 {activeChecksum}</span></>}
                      </>
                      : item.status === "failed"
                        ? "Agent QA tidak mengirim file ini. Coba kirim ulang dari tindakan di bawah."
                        : "Menunggu agent QA mengirim file ini."}
                  </p>
                  {item.status === "ready" && activeVersion?.revisionNote && (
                    <p className="artifact-note">{activeVersion.revisionNote}</p>
                  )}
                </div>

                {item.status === "ready" && item.downloadUrl
                  ? <div className="artifact-actions">
                    <button
                      className="button button-primary"
                      type="button"
                      disabled={downloading !== null}
                      onClick={() => void downloadItem(item)}
                    >
                      {downloading === item.deliverableId
                        ? "Mengunduh…"
                        : activeVersionNumber !== null
                          ? `Unduh v${activeVersionNumber}`
                          : "Unduh"}
                    </button>
                    <button
                      className="button button-quiet"
                      type="button"
                      disabled={issuingGrant !== null || stale}
                      onClick={() => void issueRevisionGrant(item)}
                    >
                      {issuingGrant === item.deliverableId ? "Menerbitkan…" : "Izin revisi agent"}
                    </button>
                  </div>
                  : <span className="artifact-wait" aria-hidden="true">—</span>}
              </div>

              {grantError && (
                <p className="banner banner-error artifact-banner" role="alert">
                  Izin revisi belum dapat diterbitkan. {grantError}
                </p>
              )}

              {grant && (
                <div className="grant-box" role="region" aria-label={`Izin revisi ${deliverableCatalog[item.kind].label}`}>
                  <div className="grant-head">
                    <div>
                      <strong>Izin revisi sementara siap digunakan</strong>
                      <p className="grant-meta">
                        Berbasis v{grant.activeVersionNumber} · berlaku sampai {formatDateTime(grant.expiresAt)} · status dokumen default:{" "}
                        <strong>{documentStatusLabel[grant.documentStatusDefault]}</strong>
                      </p>
                    </div>
                    <button type="button" className="link-button" onClick={() => dismissGrant(item.deliverableId)}>
                      Tutup &amp; bersihkan
                    </button>
                  </div>

                  <div className="grant-fields">
                    <div className="grant-field">
                      <label className="grant-label" htmlFor={`grant-url-${item.deliverableId}`}>URL unggah revisi</label>
                      <div className="grant-input-row">
                        <input
                          id={`grant-url-${item.deliverableId}`}
                          className="input mono grant-input"
                          type="text"
                          readOnly
                          value={grant.uploadUrl}
                        />
                        <button
                          type="button"
                          className="button button-quiet"
                          onClick={() => void copyGrantField(item.deliverableId, "URL revisi", grant.uploadUrl)}
                        >
                          Salin URL
                        </button>
                      </div>
                    </div>

                    <div className="grant-field">
                      <label className="grant-label" htmlFor={`grant-token-${item.deliverableId}`}>Token unggah (Bearer)</label>
                      <div className="grant-input-row">
                        <input
                          id={`grant-token-${item.deliverableId}`}
                          className="input mono grant-input"
                          type={tokenVisible ? "text" : "password"}
                          readOnly
                          autoComplete="off"
                          spellCheck={false}
                          value={grant.uploadToken}
                        />
                        <button
                          type="button"
                          className="button button-quiet"
                          onClick={() => setRevealedTokens(current => ({ ...current, [item.deliverableId]: !tokenVisible }))}
                        >
                          {tokenVisible ? "Sembunyikan" : "Tampilkan"}
                        </button>
                        <button
                          type="button"
                          className="button button-quiet"
                          onClick={() => void copyGrantField(item.deliverableId, "Token revisi", grant.uploadToken)}
                        >
                          Salin token
                        </button>
                      </div>
                    </div>
                  </div>

                  {copyFeedback[item.deliverableId] && (
                    <p className="grant-feedback" role="status">{copyFeedback[item.deliverableId]}</p>
                  )}
                  <p className="help">
                    Teruskan URL dan token ini ke agent QA lewat jalur aman. Jangan simpan di repo, catatan publik, atau log. Token hanya tersimpan sementara di layar ini dan tidak mengubah status eksekusi job.
                  </p>
                </div>
              )}

              {versions.length > 0 && (
                <div className="version-history">
                  <div className="version-history-head">
                    <button
                      type="button"
                      className="link-button"
                      aria-expanded={historyOpen}
                      aria-controls={`versions-${item.deliverableId}`}
                      onClick={() => setExpandedHistory(current => ({ ...current, [item.deliverableId]: !historyOpen }))}
                    >
                      {historyOpen ? "Sembunyikan riwayat versi" : "Lihat riwayat versi"} ({versions.length}
                      {olderVersions.length > 0 ? ` · ${olderVersions.length} versi lama` : ""})
                    </button>
                  </div>

                  {historyOpen && (
                    <ol className="version-list" id={`versions-${item.deliverableId}`}>
                      {versions.map(version => {
                        const versionKey = `version:${version.versionId}`;
                        const checksum = shortChecksum(version.sha256);
                        return <li className="version-row" key={version.versionId} data-active={version.isActive ? "true" : undefined}>
                          <div className="version-main">
                            <div className="version-title">
                              <span className="mono version-num">v{version.versionNumber}</span>
                              <span className={`artifact-badge ${version.isActive ? "artifact-badge-version" : "artifact-badge-archived"}`}>
                                {version.isActive ? "Aktif" : "Versi lama"}
                              </span>
                              <span className={`artifact-badge artifact-badge-${version.documentStatus}`}>
                                {documentStatusLabel[version.documentStatus]}
                              </span>
                            </div>
                            <p className="version-meta">
                              {version.fileName} · {formatBytes(version.sizeBytes)} · {formatDateTime(version.readyAt)}
                              {checksum && <> · <span className="mono">SHA-256 {checksum}</span></>}
                            </p>
                            {version.revisionNote && <p className="version-note">{version.revisionNote}</p>}
                          </div>
                          <button
                            className="button button-quiet"
                            type="button"
                            disabled={downloading !== null}
                            onClick={() => void downloadVersion(item, version)}
                          >
                            {downloading === versionKey ? "Mengunduh…" : `Unduh v${version.versionNumber}`}
                          </button>
                        </li>;
                      })}
                    </ol>
                  )}
                </div>
              )}
            </li>;
          })}
        </ul>}

        {legacy && job.result && <div className="legacy-result">
          <div className="result-block"><h3>Ringkasan</h3><p className="preserve-lines">{job.result.summary}</p></div>
          <div className="result-block"><h3>Pemeriksaan</h3>
            <ul className="checks-list">{job.result.checks.map(check => <li key={check.criterionIndex}>
              <span className={`outcome outcome-${check.outcome}`}>{outcomeLabel[check.outcome]}</span>
              <div><strong>{job.acceptanceCriteria[check.criterionIndex] ?? `Kriteria ${check.criterionIndex + 1}`}</strong><p className="preserve-lines">{check.note || "Tanpa catatan."}</p></div>
            </li>)}</ul>
          </div>
          <div className="result-block"><h3>Temuan</h3>
            {job.result.findings.length === 0 ? <p>Tidak ada temuan yang dilaporkan.</p>
              : <ol className="findings-list">{job.result.findings.map((finding, index) => <li key={index}>
                <strong>{finding.title}</strong>
                <dl><dt>Langkah</dt><dd className="preserve-lines">{finding.steps}</dd><dt>Harapan</dt><dd className="preserve-lines">{finding.expected}</dd><dt>Aktual</dt><dd className="preserve-lines">{finding.actual}</dd></dl>
              </li>)}</ol>}
          </div>
        </div>}

        {legacy && !job.result && <p className="empty-inline">Belum ada hasil untuk permintaan ini. Status eksekusi tidak berarti hasil QA sudah diterima.</p>}
      </section>

      <aside className="panel" aria-labelledby="request-title">
        <h2 id="request-title">Ringkasan permintaan</h2>
        {request ? <dl className="summary-list">
          <div><dt>URL target</dt><dd className="mono">{request.targetUrl}</dd></div>
          <div><dt>Environment</dt><dd>{environmentLabel[request.environment]}</dd></div>
          <div><dt>Kebutuhan akses</dt><dd>
            <span className="tag">{request.accessRequiresLogin ? "Perlu login" : "Tanpa login"}</span>
            {request.accessNotes && <p className="preserve-lines sub-note">{request.accessNotes}</p>}
          </dd></div>
          <div><dt>Cakupan</dt><dd><ol className="scope-summary">{request.scopeUrls.map(url => <li key={url} className="mono">{url}</li>)}</ol></dd></div>
          <div><dt>Deliverable</dt><dd><span className="tag-list">{request.deliverables.map(kind => <span className="tag" key={kind}>{deliverableCatalog[kind].label}</span>)}</span></dd></div>
          <div><dt>Kriteria penerimaan</dt><dd><ol className="scope-summary">{request.acceptanceCriteria.map((item, index) => <li key={index}>{item}</li>)}</ol></dd></div>
          <div><dt>Saran</dt><dd className="preserve-lines">{request.suggestions || "Tidak ada"}</dd></div>
          <div><dt>Larangan</dt><dd className="preserve-lines">{request.prohibitions || "Tidak ada"}</dd></div>
        </dl> : <dl className="summary-list">
          <div><dt>Cakupan</dt><dd className="preserve-lines">{job.scope}</dd></div>
          <div><dt>Kriteria penerimaan</dt><dd><ol className="scope-summary">{job.acceptanceCriteria.map((item, index) => <li key={index}>{item}</li>)}</ol></dd></div>
        </dl>}

        <div className="actions">
          {canRetry && <button type="button" className="button button-primary" onClick={() => void act("retry")} disabled={busy !== null || stale}>{busy === "retry" ? "Mencoba ulang…" : "Kirim ulang"}</button>}
          {canReconcileNow && <button type="button" className="button button-quiet" onClick={() => void act("reconcile")} disabled={busy !== null || stale}>{busy === "reconcile" ? "Memeriksa…" : "Rekonsiliasi status"}</button>}
          <button type="button" className="button button-quiet" onClick={() => void load()} disabled={busy !== null}>Muat ulang</button>
        </div>
        {leaseActive && <p className="help">Pengiriman sedang berjalan sampai {formatDateTime(job.leaseExpiresAt)}. Tunggu sebelum mencoba lagi.</p>}
        <p className="foot-note">File hanya bisa diunduh oleh pemilik akun. Tautan unduhan langsung akan gagal untuk akun lain.</p>
      </aside>
    </div>
  </main>;
}

async function callJobAction(jobId: string, action: Action) {
  return apiRequest<JobResponse>(`/jobs/${encodeURIComponent(jobId)}/${action}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  });
}
