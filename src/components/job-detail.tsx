"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  canReconcile, isTerminal,
  type Job, type JobResponse,
} from "@/contracts";
import {
  deliverableCatalog, type Deliverable, type Submission,
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
const outcomeLabel = { pass: "Sesuai", fail: "Tidak sesuai", blocked: "Terhalang" } as const;

type Progress = { request: Submission | null; items: Deliverable[]; ready: number; total: number; partial: boolean };
type Action = "dispatch" | "retry" | "reconcile";

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
    const path = `/api/v1/jobs/${encodeURIComponent(jobId)}/deliverables/${encodeURIComponent(item.deliverableId)}`;
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
          {items.map(item => <li className="artifact" key={item.deliverableId} data-status={item.status}>
            <div className="artifact-main">
              <div className="artifact-title">
                <strong>{deliverableCatalog[item.kind].label}</strong>
                <StatusChip tone={itemTone[item.status]}>{itemLabel[item.status]}</StatusChip>
              </div>
              <p className="artifact-meta">
                {item.status === "ready"
                  ? <>{item.fileName} · {formatBytes(item.sizeBytes)} · {formatDateTime(item.readyAt)}</>
                  : item.status === "failed"
                    ? "Agent QA tidak mengirim file ini. Coba kirim ulang dari tindakan di bawah."
                    : "Menunggu agent QA mengirim file ini."}
              </p>
            </div>
            {item.status === "ready" && item.downloadUrl
              ? <button className="button button-quiet" type="button" disabled={downloading !== null} onClick={() => void downloadItem(item)}>
                  {downloading === item.deliverableId ? "Mengunduh…" : "Unduh"}
                </button>
              : <span className="artifact-wait" aria-hidden="true">—</span>}
          </li>)}
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
