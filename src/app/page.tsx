"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Job, JobListResponse } from "@/contracts";
import { deliverableCatalog, type Draft } from "@/contracts/requests";
import { apiRequest, errorText } from "@/components/api-client";
import SessionGate, { type SessionContext } from "@/components/session-gate";
import { StatusChip, formatDateTime, type Tone } from "@/components/ui";

type FilterKey = "all" | "draft" | "not_sent" | "active" | "done" | "problem";

const filters: { key: FilterKey; label: string }[] = [
  { key: "all", label: "Semua" },
  { key: "draft", label: "Draf" },
  { key: "not_sent", label: "Belum dikirim" },
  { key: "active", label: "Berjalan" },
  { key: "done", label: "Selesai" },
  { key: "problem", label: "Bermasalah" },
];

type Row = {
  key: string;
  href: string;
  target: string;
  statusLabel: string;
  tone: Tone;
  filter: Exclude<FilterKey, "all">;
  action: string;
  updatedAt: string;
  detail: string;
  deliverables: string[];
};

function draftRow(draft: Draft): Row {
  const data = draft.data;
  const labels = (data.deliverables ?? []).map(kind => deliverableCatalog[kind].label);
  const scope = data.scopeUrls?.length ? `${data.scopeUrls.length} URL cakupan` : "Cakupan belum diisi";
  return {
    key: `draft-${draft.draftId}`,
    href: `/permintaan/${draft.draftId}`,
    target: data.targetUrl?.trim() || "Draf tanpa URL target",
    statusLabel: "Draf",
    tone: "neutral",
    filter: "draft",
    action: "Lanjut isi",
    updatedAt: draft.updatedAt,
    detail: data.accessRequiresLogin ? `${scope} · perlu login` : scope,
    deliverables: labels,
  };
}

function jobRow(job: Job): Row {
  const base = {
    key: `job-${job.jobId}`,
    href: `/job/${job.jobId}`,
    target: job.targetUrl,
    updatedAt: job.updatedAt,
    deliverables: [] as string[],
  };
  if (job.deliveryStatus === "not_sent") {
    return { ...base, statusLabel: "Belum dikirim", tone: "neutral", filter: "not_sent", action: "Buka & kirim", detail: "Menunggu dikirim ke agent QA" };
  }
  if (job.deliveryStatus === "sending") {
    return { ...base, statusLabel: "Mengirim ke QA", tone: "info", filter: "active", action: "Lihat status", detail: "Pengiriman sedang diproses" };
  }
  if (job.deliveryStatus === "failed") {
    return { ...base, statusLabel: "Pengiriman gagal", tone: "problem", filter: "problem", action: "Lihat status", detail: job.lastError?.message ?? "Coba kirim ulang dari halaman detail" };
  }
  if (job.deliveryStatus === "unknown") {
    return { ...base, statusLabel: "Pengiriman belum pasti", tone: "problem", filter: "problem", action: "Lihat status", detail: "Periksa status sebelum mengirim ulang" };
  }
  if (job.executionStatus === "succeeded") {
    return { ...base, statusLabel: "Selesai", tone: "done", filter: "done", action: "Lihat hasil", detail: "Hasil pengujian tersedia" };
  }
  if (job.executionStatus === "failed") {
    return { ...base, statusLabel: "Pengujian gagal", tone: "problem", filter: "problem", action: "Lihat hasil", detail: job.lastError?.message ?? "Eksekusi tidak selesai" };
  }
  if (job.executionStatus === "running") {
    return { ...base, statusLabel: "Sedang diuji", tone: "active", filter: "active", action: "Lihat status", detail: "Agent QA sedang menguji" };
  }
  return { ...base, statusLabel: "Diterima QA", tone: "info", filter: "active", action: "Lihat status", detail: "Menunggu eksekusi dimulai" };
}

export default function Page() {
  return <SessionGate>{context => <RequestList context={context} />}</SessionGate>;
}

function RequestList({ context }: { context: SessionContext }) {
  const { user, signal, onAuthFailure, onLogout } = context;
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterKey>("all");

  const load = useCallback(async () => {
    setState("loading");
    setError("");
    try {
      const [draftResult, jobResult] = await Promise.all([
        apiRequest<{ drafts: Draft[] }>("/drafts", { signal }),
        apiRequest<JobListResponse>("/jobs", { signal }),
      ]);
      setDrafts(draftResult.drafts);
      setJobs(jobResult.jobs);
      setState("ready");
    } catch (caught) {
      if (signal.aborted || onAuthFailure(caught)) return;
      setError(errorText(caught));
      setState("error");
    }
  }, [signal, onAuthFailure]);

  useEffect(() => { void load(); }, [load]);

  const rows = useMemo(() => {
    const all = [...drafts.map(draftRow), ...jobs.map(jobRow)];
    return all.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  }, [drafts, jobs]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter(row => {
      if (filter !== "all" && row.filter !== filter) return false;
      if (!needle) return true;
      return [row.target, row.statusLabel, row.detail, ...row.deliverables].join(" ").toLowerCase().includes(needle);
    });
  }, [rows, filter, query]);

  const counts = useMemo(() => {
    const tally = { all: rows.length, draft: 0, not_sent: 0, active: 0, done: 0, problem: 0 };
    for (const row of rows) tally[row.filter] += 1;
    return tally;
  }, [rows]);

  return <main className="shell">
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">QA</span>
        <span className="brand-text"><strong>Dashboard QA</strong><span>Permintaan pengujian internal</span></span>
      </div>
      <div className="topbar-account">
        <span>{user.email ?? "Akun aktif"}</span>
        <button type="button" className="link-button" onClick={onLogout}>Keluar</button>
      </div>
    </header>

    <section className="page-head" aria-labelledby="page-title">
      <div>
        <p className="eyebrow">PERMINTAAN QA</p>
        <h1 id="page-title">Semua permintaan</h1>
        <p className="page-lede">
          {state === "ready"
            ? `${counts.all} permintaan · ${counts.draft} draf · ${counts.not_sent} belum dikirim · ${counts.active} berjalan · ${counts.done} selesai`
            : "Pantau draf, permintaan yang sedang diuji, dan hasil pengujian milik akunmu."}
        </p>
      </div>
      <div className="page-actions">
        <Link className="button button-primary" href="/permintaan/baru">Buat permintaan</Link>
      </div>
    </section>

    {state === "error" && rows.length > 0 && <div className="banner banner-error" role="alert">
      <strong>Daftar mungkin sudah berubah.</strong>
      <p>{error}</p>
      <p>Yang tampil adalah data terakhir yang berhasil dimuat.</p>
      <button type="button" className="button button-quiet" onClick={() => void load()}>Coba muat ulang</button>
    </div>}

    <section className="panel list-panel" aria-label="Daftar permintaan QA">
      <div className="toolbar">
        <div className="field search-field">
          <label className="field-label" htmlFor="search">Cari permintaan</label>
          <input
            id="search" className="input" type="search" value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="URL target, status, atau nama deliverable"
          />
        </div>
        <div className="field filter-field">
          <label className="field-label" htmlFor="filter">Status</label>
          <select id="filter" className="input select" value={filter} onChange={event => setFilter(event.target.value as FilterKey)}>
            {filters.map(item => <option key={item.key} value={item.key}>
              {item.label}{state === "ready" ? ` (${counts[item.key]})` : ""}
            </option>)}
          </select>
        </div>
        <button type="button" className="button button-quiet toolbar-refresh" onClick={() => void load()} disabled={state === "loading"}>
          {state === "loading" ? "Memuat…" : "Muat ulang"}
        </button>
      </div>

      {state === "loading" && rows.length === 0
        ? <p className="empty" role="status">Memuat permintaan…</p>
        : state === "error" && rows.length === 0
          ? <div className="empty">
            <strong>Daftar belum tersedia.</strong>
            <span>Muat ulang untuk mencoba mengambil daftar permintaan lagi.</span>
            <button type="button" className="button button-quiet" onClick={() => void load()}>Coba muat ulang</button>
          </div>
          : rows.length === 0
            ? <div className="empty">
              <strong>Belum ada permintaan.</strong>
              <span>Mulai dengan membuat permintaan pengujian pertama. Draf yang baru terisi sebagian tetap bisa disimpan.</span>
              <Link className="button button-primary" href="/permintaan/baru">Buat permintaan</Link>
            </div>
            : visible.length === 0
              ? <div className="empty">
                <strong>Tidak ada hasil yang cocok.</strong>
                <span>Ubah kata kunci atau pilih status lain.</span>
                <button type="button" className="button button-quiet" onClick={() => { setQuery(""); setFilter("all"); }}>Bersihkan filter</button>
              </div>
              : <table className="req-table">
                <caption className="visually-hidden">Permintaan QA milik akun ini</caption>
                <thead>
                  <tr>
                    <th scope="col">Permintaan</th>
                    <th scope="col">Status</th>
                    <th scope="col">Diperbarui</th>
                    <th scope="col"><span className="visually-hidden">Tindakan</span></th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map(row => <tr key={row.key}>
                    <td data-label="Permintaan" className="cell-target">
                      <span className="target-url">{row.target}</span>
                      <span className="target-meta">{row.detail}</span>
                      {row.deliverables.length > 0 && <span className="tag-list">
                        {row.deliverables.map(label => <span className="tag" key={label}>{label}</span>)}
                      </span>}
                    </td>
                    <td data-label="Status"><StatusChip tone={row.tone}>{row.statusLabel}</StatusChip></td>
                    <td data-label="Diperbarui" className="cell-date">{formatDateTime(row.updatedAt)}</td>
                    <td data-label="Tindakan" className="cell-action">
                      <Link className="button button-quiet row-action" href={row.href}>{row.action}</Link>
                    </td>
                  </tr>)}
                </tbody>
              </table>}

      <p className="visually-hidden" role="status">
        {state === "ready" ? `${visible.length} dari ${rows.length} permintaan ditampilkan.` : ""}
      </p>

      {state === "ready" && rows.length > 0 && <p className="foot-note">Menampilkan maksimal 100 draf dan 100 permintaan terbaru milik akun aktif. Hasil hanya bisa dibuka oleh pemilik akun.</p>}
    </section>
  </main>;
}
