"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  canReconcile, createJobSchema, deliverables, isTerminal, uuidSchema,
  type CreateJob, type Job, type JobListResponse, type JobResponse, type SessionResponse, type SessionUser,
} from "@/contracts";
import { apiRequest, authStateFor, errorText, HttpError } from "@/components/api-client";

const pendingKeyFor = (userId: string) => `qa-proof-pending-create-v2:${userId}`;
type PendingCreate = { key: string; payload: CreateJob };
type Notice = { kind: "error" | "info"; text: string } | null;
function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
const deliveryLabel: Record<Job["deliveryStatus"], string> = {
  not_sent: "Belum dikirim", sending: "Mengirim", accepted: "Diterima agent QA",
  failed: "Pengiriman gagal", unknown: "Pengiriman belum pasti",
};
const executionLabel: Record<Job["executionStatus"], string> = {
  not_started: "Belum dimulai", running: "Berjalan", succeeded: "Selesai", failed: "Gagal",
};
const outcomeLabel = { pass: "Sesuai", fail: "Tidak sesuai", blocked: "Terhalang" } as const;

export default function Home() {
  const [view, setView] = useState<"loading" | "ready" | "login" | "forbidden" | "setup" | "error">("loading");
  const [user, setUser] = useState<SessionUser | null>(null);
  const [authNotice, setAuthNotice] = useState("");
  const sessionSeq = useRef(0);
  const sessionController = useRef<AbortController | null>(null);

  const loadSession = useCallback(async () => {
    const seq = ++sessionSeq.current;
    sessionController.current?.abort();
    const controller = new AbortController();
    sessionController.current = controller;
    setUser(null);
    setView("loading");
    try {
      const data = await apiRequest<SessionResponse>("/auth/session", { signal: controller.signal });
      if (seq !== sessionSeq.current) return;
      setUser(data.user);
      setAuthNotice("");
      setView("ready");
    } catch (error) {
      if (seq !== sessionSeq.current || controller.signal.aborted) return;
      setAuthNotice(errorText(error));
      setView(authStateFor(error) ?? "error");
    }
  }, []);

  useEffect(() => {
    void loadSession();
    return () => { sessionSeq.current++; sessionController.current?.abort(); };
  }, [loadSession]);

  const onAuthFailure = useCallback((error: unknown) => {
    const next = authStateFor(error);
    if (!next) return false;
    sessionSeq.current++;
    sessionController.current?.abort();
    setUser(null);
    setAuthNotice(errorText(error));
    setView(next);
    return true;
  }, []);

  async function logout() {
    sessionSeq.current++;
    sessionController.current?.abort();
    setUser(null);
    setView("loading");
    setAuthNotice("Menutup sesi…");
    try {
      await apiRequest<{ signedOut: true }>("/auth/logout", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      setView("login");
      setAuthNotice("Sesi ditutup. Silakan login kembali.");
    } catch (error) {
      setView("error");
      setAuthNotice(`Logout belum dapat dikonfirmasi. ${errorText(error)} Periksa sesi sebelum melanjutkan.`);
    }
  }

  if (view === "ready" && user) return <Dashboard key={user.id} user={user} onLogout={logout} onAuthFailure={onAuthFailure} />;
  return <main className="shell auth-shell">
    <section className="panel auth-panel" aria-labelledby="auth-title">
      <p className="eyebrow">DASHBOARD QA</p>
      <h1 id="auth-title">{view === "loading" ? "Memeriksa sesi…" : view === "login" ? "Sesi diperlukan" : view === "forbidden" ? "Akses belum diizinkan" : view === "setup" ? "Konfigurasi belum siap" : "Sesi belum dapat diperiksa"}</h1>
      <p>{view === "login" ? "Masuk dengan akun yang diundang operator untuk melihat job milikmu." : view === "forbidden" ? "Akun ini belum aktif dalam daftar anggota Dashboard QA. Hubungi operator." : view === "setup" ? "Aplikasi memerlukan konfigurasi Supabase dan origin yang valid dari operator." : view === "error" ? "Tidak ada data job yang ditampilkan sampai sesi terverifikasi." : "Menunggu respons layanan autentikasi."}</p>
      {authNotice && <p className="notice notice-error" role="alert">{authNotice}</p>}
      <div className="actions">{view === "login" && <a className="button button-primary" href="/login">Ke halaman login</a>}{view !== "loading" && <button type="button" className="button button-quiet" onClick={() => void loadSession()}>Periksa sesi lagi</button>}</div>
    </section>
  </main>;
}

function Dashboard({ user, onLogout, onAuthFailure }: { user: SessionUser; onLogout: () => void; onAuthFailure: (error: unknown) => boolean }) {
  const pendingKey = pendingKeyFor(user.id);
  const requestController = useRef<AbortController | null>(null);
  const activeRef = useRef(false);
  useEffect(() => {
    activeRef.current = true;
    const controller = new AbortController();
    requestController.current = controller;
    return () => { activeRef.current = false; controller.abort(); requestController.current = null; };
  }, []);
  const call = useCallback(<T,>(path: string, init?: RequestInit) =>
    apiRequest<T>(path, { ...init, signal: requestController.current?.signal }), []);
  const [targetUrl, setTargetUrl] = useState("https://example.invalid/qa-demo");
  const [scope, setScope] = useState("");
  const [criteria, setCriteria] = useState("");
  const [formError, setFormError] = useState("");
  const [invalidField, setInvalidField] = useState<"targetUrl" | "scope" | "acceptanceCriteria" | null>(null);
  const [storageBlocked, setStorageBlocked] = useState(false);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [detail, setDetail] = useState<Job | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listFailed, setListFailed] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState<"create" | "dispatch" | "retry" | "reconcile" | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [stale, setStale] = useState(false);
  const [pending, setPending] = useState<PendingCreate | null>(null);
  const selectedRef = useRef<string | null>(null);
  const listSeq = useRef(0);
  const detailSeq = useRef(0);
  const busyRef = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);

  const selectedJob = useMemo(() =>
    (detail?.jobId === selectedId ? detail : null) ?? jobs.find(job => job.jobId === selectedId) ?? null,
  [detail, jobs, selectedId]);

  const replaceJob = useCallback((job: Job) => {
    setJobs(current => {
      const previous = current.find(item => item.jobId === job.jobId);
      if (previous && previous.version > job.version) return current;
      const next = current.filter(item => item.jobId !== job.jobId);
      next.unshift(job);
      return next;
    });
    if (selectedRef.current === job.jobId) setDetail(current => current && current.version > job.version ? current : job);
  }, []);

  const loadJobs = useCallback(async (showLoading = false) => {
    const seq = ++listSeq.current;
    if (showLoading) setListLoading(true);
    try {
      const data = await call<JobListResponse>("/jobs");
      if (seq !== listSeq.current) return;
      setListFailed(false);
      setJobs(data.jobs);
      setDetail(current => {
        const updated = data.jobs.find(job => job.jobId === current?.jobId);
        return updated && current && updated.version > current.version ? updated : current;
      });
      if (!selectedRef.current && data.jobs.length) {
        selectedRef.current = data.jobs[0].jobId;
        setSelectedId(data.jobs[0].jobId);
      }
      setStale(false);
      setNotice(current => current?.kind === "error" ? { kind: "info", text: "Status terbaru dimuat. Tinjau job sebelum aksi berikutnya." } : current);
    } catch (error) {
      if (seq !== listSeq.current) return;
      if (!activeRef.current || requestController.current?.signal.aborted || onAuthFailure(error)) return;
      setListFailed(true);
      setStale(true);
      setNotice({ kind: "error", text: `Daftar job belum diperbarui. ${errorText(error)}` });
    } finally {
      if (seq === listSeq.current) setListLoading(false);
    }
  }, [call, onAuthFailure]);

  const loadDetail = useCallback(async (id: string, showLoading = false) => {
    const seq = ++detailSeq.current;
    if (showLoading) setDetailLoading(true);
    try {
      const data = await call<JobResponse>(`/jobs/${encodeURIComponent(id)}`);
      if (seq !== detailSeq.current || selectedRef.current !== id) return;
      if (data.job.jobId !== id) throw new Error("Respons detail tidak cocok dengan job yang dipilih.");
      setDetail(current => current && current.version > data.job.version ? current : data.job);
      setJobs(current => current.map(job => job.jobId === id && job.version <= data.job.version ? data.job : job));
      setStale(false);
      setNotice(current => current?.kind === "error" ? { kind: "info", text: "Detail terbaru dimuat. Tinjau status sebelum aksi berikutnya." } : current);
    } catch (error) {
      if (seq !== detailSeq.current || selectedRef.current !== id) return;
      if (!activeRef.current || requestController.current?.signal.aborted || onAuthFailure(error)) return;
      setStale(true);
      setNotice({ kind: "error", text: `Detail job belum diperbarui. ${errorText(error)}` });
    } finally {
      if (seq === detailSeq.current && selectedRef.current === id) setDetailLoading(false);
    }
  }, [call, onAuthFailure]);

  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(pendingKey);
      if (saved) {
        const parsed = JSON.parse(saved) as PendingCreate;
        if (uuidSchema.safeParse(parsed.key).success && createJobSchema.safeParse(parsed.payload).success) {
          setPending(parsed);
          setTargetUrl(parsed.payload.targetUrl);
          setScope(parsed.payload.scope);
          setCriteria(parsed.payload.acceptanceCriteria.join("\n"));
          setNotice({ kind: "info", text: "Ada pembuatan job yang hasilnya belum pasti. Pulihkan dengan kunci dan payload yang sama." });
        } else {
          setStorageBlocked(true);
          setNotice({ kind: "error", text: "Data pembuatan tertunda tidak valid. Periksa penyimpanan sesi sebelum membuat job baru." });
        }
      }
    } catch {
      setStorageBlocked(true);
      setNotice({ kind: "error", text: "Penyimpanan sesi tidak dapat dibaca. Pembuatan job dinonaktifkan agar tidak terduplikasi." });
    }
    void loadJobs(true);
  }, [loadJobs, pendingKey]);

  useEffect(() => {
    if (!selectedId) return;
    void loadDetail(selectedId, true);
    return () => { detailSeq.current++; };
  }, [selectedId, loadDetail]);

  useEffect(() => {
    if (!selectedJob || isTerminal(selectedJob)) return;
    const timer = window.setInterval(() => {
      if (selectedRef.current === selectedJob.jobId) void loadDetail(selectedJob.jobId);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [selectedJob?.jobId, selectedJob?.executionStatus, loadDetail]);

  function selectJob(id: string) {
    if (selectedRef.current === id) return;
    selectedRef.current = id;
    detailSeq.current++;
    setDetail(null);
    setSelectedId(id);
  }

  async function sendCreate(item: PendingCreate) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy("create");
    setNotice(null);
    try {
      const data = await call<JobResponse>("/jobs", {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": item.key },
        body: JSON.stringify(item.payload),
      });
      try { sessionStorage.removeItem(pendingKey); }
      catch { setStorageBlocked(true); }
      setPending(null);
      listSeq.current++;
      detailSeq.current++;
      setListLoading(false);
      replaceJob(data.job);
      selectJob(data.job.jobId);
      setScope("");
      setCriteria("");
      setStale(false);
      setNotice({ kind: "info", text: "Job tersimpan. Job belum dikirim; pilih Kirim untuk mengirim ke agent QA." });
      void loadJobs();
    } catch (error) {
      if (!activeRef.current || requestController.current?.signal.aborted || onAuthFailure(error)) return;
      if (error instanceof HttpError && error.status === 409) {
        setStale(true);
        setNotice({ kind: "error", text: `Konflik pembuatan: ${errorText(error)} Daftar akan diperbarui; jangan buat job baru sebelum hasilnya jelas.` });
        void loadJobs();
      } else if (error instanceof HttpError && error.status >= 400 && error.status < 500) {
        try { sessionStorage.removeItem(pendingKey); }
        catch { setStorageBlocked(true); }
        setPending(null);
        setNotice({ kind: "error", text: `Job tidak dibuat. ${errorText(error)}` });
      } else {
        setStale(true);
        setNotice({ kind: "error", text: "Hasil pembuatan belum pasti. Payload dan kunci disimpan dalam sesi; gunakan Pulihkan pembuatan. Jangan buat job baru." });
      }
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }

  function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyRef.current || pending || storageBlocked) return;
    const payload: CreateJob = {
      schemaVersion: 1, targetUrl: targetUrl.trim(), scope: scope.trim(),
      acceptanceCriteria: criteria.split("\n").map(line => line.trim()).filter(Boolean),
      deliverables: [...deliverables],
    };
    const validated = createJobSchema.safeParse(payload);
    if (!validated.success) {
      const field = validated.error.issues[0]?.path[0];
      const first = field === "targetUrl" || field === "scope" || field === "acceptanceCriteria" ? field : "acceptanceCriteria";
      setInvalidField(first);
      setFormError("Periksa URL HTTP(S) tanpa kredensial, scope, dan 1–10 kriteria (satu per baris). Batas: scope 2.000 dan tiap kriteria 500 karakter.");
      formRef.current?.querySelector<HTMLElement>(`[data-field='${first}']`)?.focus();
      return;
    }
    setFormError("");
    setInvalidField(null);
    const item = { key: crypto.randomUUID(), payload: validated.data };
    try { sessionStorage.setItem(pendingKey, JSON.stringify(item)); }
    catch {
      setStorageBlocked(true);
      setNotice({ kind: "error", text: "Penyimpanan sesi tidak tersedia. Job tidak dikirim agar pemulihan aman." });
      return;
    }
    setPending(item);
    void sendCreate(item);
  }

  async function handleJobAction(action: "dispatch" | "retry" | "reconcile", job: Job) {
    if (busyRef.current || isTerminal(job)) return;
    if (action === "dispatch" && job.deliveryStatus !== "not_sent") return;
    const leaseActive = job.leaseExpiresAt !== null && Date.parse(job.leaseExpiresAt) > Date.now();
    if (action === "retry" && (leaseActive || !(job.deliveryStatus === "failed" || job.deliveryStatus === "unknown" || (job.deliveryStatus === "sending" && job.leaseExpiresAt !== null)))) return;
    if (action === "reconcile" && !canReconcile(job)) return;
    busyRef.current = true;
    setBusy(action);
    setNotice(null);
    listSeq.current++;
    detailSeq.current++;
    setListLoading(false);
    try {
      const data = await call<JobResponse>(`/jobs/${encodeURIComponent(job.jobId)}/${action}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      listSeq.current++;
      detailSeq.current++;
      replaceJob(data.job);
      setStale(false);
      setNotice({ kind: "info", text: "Aksi QA dicatat. Perbarui status untuk melihat hasil terkini." });
      void loadDetail(job.jobId);
    } catch (error) {
      if (!activeRef.current || requestController.current?.signal.aborted || onAuthFailure(error)) return;
      setStale(true);
      setNotice({ kind: "error", text: error instanceof HttpError && error.status === 409
        ? `Status job berubah atau aksi tidak diizinkan. ${errorText(error)} Memuat ulang untuk rekonsiliasi.`
        : `Hasil aksi belum dapat dipastikan. ${errorText(error)} Memuat ulang status tanpa mengulang pengiriman.` });
      void loadDetail(job.jobId);
      void loadJobs();
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }

  return <main className="shell">
    <header className="masthead">
      <div><p className="eyebrow">QA / OPENBOT AGENT</p><h1>Dashboard pengujian</h1><p className="subhead">Catat permintaan, pantau eksekusi agent QA, dan tinjau hasil pengujian milik akunmu.</p></div>
      <div className="masthead-side"><div className="masthead-note"><span className="note-dot" /> <span>Terhubung ke agent QA OpenBot melalui webhook &amp; callback terverifikasi.</span></div><div className="account-bar"><span>{user.email ?? "Akun aktif"}</span><button type="button" className="text-button" onClick={onLogout}>Keluar</button></div></div>
    </header>

    {notice && <div className={`notice notice-${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>{notice.text}</div>}
    {stale && <div className="stale" role="status">Data mungkin sudah berubah. <button type="button" className="text-button" onClick={() => { void loadJobs(); if (selectedRef.current) void loadDetail(selectedRef.current); }}>Muat ulang status</button></div>}

    <div className="dashboard-grid">
      <section className="panel create-panel" aria-labelledby="create-title">
        <div className="panel-heading"><div><p className="eyebrow">01 / PERMINTAAN</p><h2 id="create-title">Buat job QA</h2></div><span className="step-mark">DRAFT</span></div>
        <p className="panel-description">Buat menyimpan job saja. Pengiriman dilakukan terpisah setelah job dipilih.</p>
        <form ref={formRef} onSubmit={handleCreate} noValidate>
          <label htmlFor="target-url">URL target <span className="required">*</span></label>
          <input id="target-url" data-field="targetUrl" type="url" inputMode="url" value={targetUrl} onChange={event => setTargetUrl(event.target.value)} aria-invalid={invalidField === "targetUrl"} aria-describedby={formError && invalidField === "targetUrl" ? "form-error" : undefined} maxLength={2048} required />
          <p className="field-help">Masukkan URL HTTP(S) target yang akan diuji oleh agent QA OpenBot.</p>

          <label htmlFor="scope">Cakupan pengujian <span className="required">*</span></label>
          <textarea id="scope" data-field="scope" value={scope} onChange={event => setScope(event.target.value)} placeholder="Contoh: alur halaman utama dan validasi formulir" rows={3} maxLength={2000} required aria-invalid={invalidField === "scope"} aria-describedby={formError && invalidField === "scope" ? "form-error" : undefined} />

          <label htmlFor="criteria">Kriteria penerimaan <span className="required">*</span></label>
          <textarea id="criteria" data-field="acceptanceCriteria" value={criteria} onChange={event => setCriteria(event.target.value)} placeholder={"Satu kriteria per baris\nContoh: formulir menampilkan pesan validasi"} rows={4} required aria-invalid={invalidField === "acceptanceCriteria"} aria-describedby={formError && invalidField === "acceptanceCriteria" ? "form-error" : undefined} />
          <p className="field-help">1–10 kriteria, masing-masing maksimal 500 karakter.</p>

          <fieldset className="deliverables"><legend>Deliverables tetap</legend>
            <span>✓ Ringkasan</span><span>✓ Pemeriksaan</span><span>✓ Temuan</span>
          </fieldset>
          {formError && <p id="form-error" className="form-error" role="alert">{formError}</p>}
          {pending ? <div className="pending-box"><p><strong>Pembuatan tertunda.</strong> Payload dan kunci tersimpan di sesi ini.</p><button type="button" className="button button-primary" disabled={busy !== null} onClick={() => void sendCreate(pending)}>{busy === "create" ? "Memulihkan…" : "Pulihkan pembuatan"}</button></div>
            : <button type="submit" className="button button-primary" disabled={busy !== null || storageBlocked}>{busy === "create" ? "Menyimpan…" : "Buat job"}</button>}
          <p className="fineprint">Jangan masukkan kredensial atau data pribadi pada URL, scope, maupun kriteria.</p>
        </form>
      </section>

      <section className="panel jobs-panel" aria-labelledby="jobs-title">
        <div className="panel-heading"><div><p className="eyebrow">02 / ANTRIAN</p><h2 id="jobs-title">Job tersimpan</h2></div><button type="button" className="button button-quiet" onClick={() => void loadJobs(true)} disabled={listLoading}>Muat ulang</button></div>
        {listLoading && jobs.length === 0 ? <p className="empty-state" role="status">Memuat daftar job…</p>
          : jobs.length === 0 && listFailed ? <div className="empty-state" role="alert"><strong>Daftar belum dapat dimuat.</strong><span>Periksa koneksi dan muat ulang status.</span></div>
          : jobs.length === 0 ? <div className="empty-state"><strong>Belum ada job.</strong><span>Isi formulir untuk membuat permintaan QA pertama.</span></div>
          : <ul className="job-list">{jobs.map(job => <li key={job.jobId}>
            <button type="button" className={`job-item ${selectedId === job.jobId ? "selected" : ""}`} onClick={() => selectJob(job.jobId)} aria-current={selectedId === job.jobId ? "true" : undefined}>
              <span className="job-item-top"><strong>{job.targetUrl}</strong><span className="job-index">#{job.jobId.slice(0, 8)}</span></span>
              <span className="job-item-bottom"><span>{deliveryLabel[job.deliveryStatus]}</span><span>{dateLabel(job.createdAt)}</span></span>
            </button>
          </li>)}</ul>}
        <p className="fineprint">Menampilkan maksimal 100 job terbaru milik akun aktif.</p>
      </section>

      <section className="panel detail-panel" aria-labelledby="detail-title">
        <div className="panel-heading"><div><p className="eyebrow">03 / TINJAUAN</p><h2 id="detail-title">Detail & hasil</h2></div>{detailLoading && <span className="updating" role="status">Memperbarui…</span>}</div>
        {!selectedJob ? <div className="empty-state"><strong>Pilih sebuah job.</strong><span>Status dan hasil QA akan tampil di sini.</span></div>
          : <>
            <div className="detail-intro"><span className="detail-kicker">JOB #{selectedJob.jobId.slice(0, 8)}</span><h3>{selectedJob.targetUrl}</h3><p>Dibuat {dateLabel(selectedJob.createdAt)} · versi {selectedJob.version}</p></div>
            <div className="status-grid">
              <div className="status-card"><span>Pengiriman{stale ? " (data lama)" : ""}</span><strong data-status={stale ? "unknown" : selectedJob.deliveryStatus}>{stale ? "Belum terverifikasi" : deliveryLabel[selectedJob.deliveryStatus]}</strong></div>
              <div className="status-card"><span>Eksekusi{stale ? " (data lama)" : ""}</span><strong data-status={stale ? "unknown" : selectedJob.executionStatus}>{stale ? "Belum terverifikasi" : executionLabel[selectedJob.executionStatus]}</strong></div>
            </div>
            {selectedJob.leaseExpiresAt && !isTerminal(selectedJob) && <p className="lease-note">Lease pengiriman sampai {dateLabel(selectedJob.leaseExpiresAt)}. Kelayakan aksi diputuskan oleh server.</p>}
            {selectedJob.lastError && <div className="job-error" role="alert"><strong>Kesalahan terakhir</strong><p>{selectedJob.lastError.message} ({selectedJob.lastError.code})</p></div>}
            <div className="actions">
              {selectedJob.deliveryStatus === "not_sent" && <button type="button" className="button button-primary" onClick={() => void handleJobAction("dispatch", selectedJob)} disabled={busy !== null || stale || isTerminal(selectedJob)}>{busy === "dispatch" ? "Mengirim…" : "Kirim ke QA"}</button>}
              {!isTerminal(selectedJob) && (selectedJob.deliveryStatus === "failed" || selectedJob.deliveryStatus === "unknown" || selectedJob.deliveryStatus === "sending") && <button type="button" className="button button-primary" onClick={() => void handleJobAction("retry", selectedJob)} disabled={busy !== null || stale || (selectedJob.leaseExpiresAt !== null && Date.parse(selectedJob.leaseExpiresAt) > Date.now()) || (selectedJob.deliveryStatus === "sending" && selectedJob.leaseExpiresAt === null)}>{busy === "retry" ? "Mencoba ulang…" : "Retry pengiriman"}</button>}
              {!isTerminal(selectedJob) && (selectedJob.deliveryStatus === "unknown" || selectedJob.deliveryStatus === "accepted" || selectedJob.deliveryStatus === "sending") && <button type="button" className="button button-quiet" onClick={() => void handleJobAction("reconcile", selectedJob)} disabled={busy !== null || stale || !canReconcile(selectedJob)}>{busy === "reconcile" ? "Merekonsiliasi…" : "Rekonsiliasi"}</button>}
              <button type="button" className="button button-quiet" onClick={() => void loadDetail(selectedJob.jobId, true)} disabled={detailLoading}>Perbarui detail</button>
            </div>
            <div className="detail-section"><h4>Cakupan</h4><p className="preserve-lines">{selectedJob.scope}</p></div>
            <div className="detail-section"><h4>Kriteria penerimaan</h4><ol className="criteria-list">{selectedJob.acceptanceCriteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ol></div>
            <div className="detail-section results-section"><div className="results-heading"><h4>Hasil QA</h4><span>{stale ? "DATA LAMA" : selectedJob.result ? "HASIL DITERIMA" : "MENUNGGU HASIL"}</span></div>
              {selectedJob.result ? <>
                <div className="result-block"><h5>Ringkasan</h5><p className="preserve-lines">{selectedJob.result.summary}</p></div>
                <div className="result-block"><h5>Pemeriksaan</h5><ul className="checks-list">{selectedJob.result.checks.map(check => <li key={check.criterionIndex}><span className={`outcome outcome-${check.outcome}`}>{outcomeLabel[check.outcome]}</span><div><strong>{selectedJob.acceptanceCriteria[check.criterionIndex] ?? `Kriteria ${check.criterionIndex + 1}`}</strong><p className="preserve-lines">{check.note || "Tanpa catatan."}</p></div></li>)}</ul></div>
                <div className="result-block"><h5>Temuan</h5>{selectedJob.result.findings.length === 0 ? <p>Tidak ada temuan yang dilaporkan.</p> : <ol className="findings-list">{selectedJob.result.findings.map((finding, index) => <li key={index}><strong>{finding.title}</strong><dl><dt>Langkah</dt><dd className="preserve-lines">{finding.steps}</dd><dt>Harapan</dt><dd className="preserve-lines">{finding.expected}</dd><dt>Aktual</dt><dd className="preserve-lines">{finding.actual}</dd></dl></li>)}</ol>}</div>
              </> : <p className="result-empty">Belum ada hasil untuk job ini. Status eksekusi tidak berarti hasil QA telah disetujui.</p>}
            </div>
            <p className="fineprint detail-footnote">Hasil di atas berasal dari eksekusi agent QA OpenBot.</p>
          </>}
      </section>
    </div>
  </main>;
}
