"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { JobResponse } from "@/contracts";
import {
  deliverableCatalog, draftDataSchema, requestUrl, scopeUrl, submissionSchema,
  type DeliverableKind, type Draft, type DraftData, type Submission,
} from "@/contracts/requests";
import { apiRequest, errorText, HttpError } from "@/components/api-client";
import type { SessionContext } from "@/components/session-gate";
import { formatDateTime } from "@/components/ui";

const stepList = [
  { title: "Target & akses", hint: "URL, environment, kebutuhan akses" },
  { title: "Cakupan", hint: "Pindai halaman publik atau tambah URL" },
  { title: "Deliverable & catatan", hint: "Hasil yang diminta dan batasan" },
  { title: "Tinjau & kirim", hint: "Periksa ringkasan sebelum dikirim" },
] as const;

const environmentOptions: { value: Submission["environment"]; label: string }[] = [
  { value: "development", label: "Development" },
  { value: "staging", label: "Staging" },
  { value: "production", label: "Production" },
  { value: "other", label: "Lainnya" },
];

const environmentLabel = (value: Submission["environment"]) =>
  environmentOptions.find(option => option.value === value)?.label ?? value;

/*
 * Cermin pola penolakan kredensial di src/contracts/requests.ts (accessNotes).
 * UI memakainya untuk pesan yang jelas sebelum menyimpan; skema tetap menjadi
 * otoritas akhir saat POST/PUT draf dan submit.
 */
const credentialPattern =
  /(?:\b(?:password|passwd|kata sandi|token|api[_ -]?key|secret|otp)\s*[:=]|\bbearer\s+[\w.-]+|https?:\/\/[^\s/?#]*@|-----BEGIN [^-]*PRIVATE KEY-----)/iu;

function accessNotesIssue(value: string): string | null {
  const text = value.trim();
  if (text.length > 1000) return "Petunjuk akses maksimal 1.000 karakter.";
  if (credentialPattern.test(text)) {
    return "Petunjuk akses tidak boleh memuat kata sandi, token, kunci API, atau pola kredensial. Tulis hanya instruksi nonrahasia.";
  }
  return null;
}

function canonicalHref(value: string): string | null {
  try {
    return new URL(value).href;
  } catch {
    return null;
  }
}

function resolveManualScopeUrl(raw: string, target: string): { url?: string; error?: string } {
  const value = raw.trim();
  if (!value) return {};
  let candidate = value;
  if (value.startsWith("#")) {
    const base = target.trim();
    if (!requestUrl.safeParse(base).success) {
      return { error: "Isi URL target yang valid di langkah pertama sebelum menambah anchor seperti #fitur." };
    }
    candidate = `${new URL(base).href}${value}`;
  }
  if (!scopeUrl.safeParse(candidate).success) {
    return { error: "URL cakupan harus HTTP(S) lengkap (boleh memakai #anchor nonkosong tanpa kredensial), atau tulis #anchor bila URL target sudah valid." };
  }
  return { url: new URL(candidate).href };
}

type PendingDraft = { key: string; data: DraftData };
type PendingSubmit = { draftId: string; revision: number };
type Notice = { kind: "info" | "error"; text: string } | null;

export default function RequestWizard({ draftId: initialDraftId, context }: { draftId?: string; context: SessionContext }) {
  const router = useRouter();
  const { user, signal, onAuthFailure } = context;
  const call = useCallback(<T,>(path: string, init?: RequestInit) => apiRequest<T>(path, { ...init, signal }), [signal]);

  const [step, setStep] = useState(0);
  const [stepError, setStepError] = useState("");
  const [notice, setNotice] = useState<Notice>(null);

  const [targetUrl, setTargetUrl] = useState("");
  const [environment, setEnvironment] = useState<Submission["environment"]>("staging");
  const [scopeUrls, setScopeUrls] = useState<string[]>([]);
  const [criteria, setCriteria] = useState<string[]>([""]);
  const [suggestions, setSuggestions] = useState("");
  const [prohibitions, setProhibitions] = useState("");
  const [picked, setPicked] = useState<DeliverableKind[]>([]);
  const [accessRequiresLogin, setAccessRequiresLogin] = useState(false);
  const [accessNotes, setAccessNotes] = useState("");

  const [draftId, setDraftId] = useState<string | undefined>(initialDraftId);
  const [revision, setRevision] = useState<number | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [saveError, setSaveError] = useState("");

  const [load, setLoad] = useState<"loading" | "ready" | "missing" | "submitted" | "error">(initialDraftId ? "loading" : "ready");
  const [loadError, setLoadError] = useState("");
  const [submittedJobId, setSubmittedJobId] = useState<string | null>(null);

  const [candidates, setCandidates] = useState<string[]>([]);
  const [scanState, setScanState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [scanMessage, setScanMessage] = useState("");
  const [manualUrl, setManualUrl] = useState("");
  const [manualError, setManualError] = useState("");

  const [busy, setBusy] = useState<"submit" | "confirm" | null>(null);
  const [submitError, setSubmitError] = useState("");
  const [pendingDraft, setPendingDraft] = useState<PendingDraft | null>(null);
  const [pendingSubmit, setPendingSubmit] = useState<PendingSubmit | null>(null);

  const headingRef = useRef<HTMLHeadingElement>(null);
  const pendingKey = `qa-draft-pending:${user.id}`;
  const submitKey = `qa-submit-pending:${user.id}`;

  const applyDraft = useCallback((draft: Draft) => {
    const data = draft.data;
    setDraftId(draft.draftId);
    setRevision(draft.revision);
    setSavedAt(draft.updatedAt);
    setTargetUrl(data.targetUrl ?? "");
    setEnvironment(data.environment ?? "staging");
    setScopeUrls(data.scopeUrls ?? []);
    setCriteria(data.acceptanceCriteria && data.acceptanceCriteria.length > 0 ? [...data.acceptanceCriteria] : [""]);
    setSuggestions(data.suggestions ?? "");
    setProhibitions(data.prohibitions ?? "");
    setPicked(data.deliverables ? [...data.deliverables] : []);
    setAccessRequiresLogin(data.accessRequiresLogin ?? false);
    setAccessNotes(data.accessNotes ?? "");
    setConflict(false);
    setSaveError("");
  }, []);

  useEffect(() => {
    if (!initialDraftId) return;
    let cancelled = false;
    setLoad("loading");
    apiRequest<{ draft: Draft }>(`/drafts/${encodeURIComponent(initialDraftId)}`, { signal })
      .then(({ draft }) => {
        if (cancelled) return;
        if (draft.jobId) {
          setSubmittedJobId(draft.jobId);
          setLoad("submitted");
          return;
        }
        applyDraft(draft);
        setLoad("ready");
      })
      .catch(error => {
        if (cancelled) return;
        if (onAuthFailure(error)) return;
        if (error instanceof HttpError && error.status === 404) {
          setLoad("missing");
          return;
        }
        setLoadError(errorText(error));
        setLoad("error");
      });
    return () => { cancelled = true; };
  }, [initialDraftId, signal, applyDraft, onAuthFailure]);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(pendingKey);
      if (raw) {
        const parsed = JSON.parse(raw) as PendingDraft;
        if (typeof parsed?.key === "string" && parsed.data) setPendingDraft(parsed);
      }
      const rawSubmit = sessionStorage.getItem(submitKey);
      if (rawSubmit) {
        const parsed = JSON.parse(rawSubmit) as PendingSubmit;
        if (typeof parsed?.draftId === "string" && typeof parsed.revision === "number") setPendingSubmit(parsed);
      }
    } catch { /* penyimpanan sesi tidak tersedia; lanjut tanpa pemulihan */ }
  }, [pendingKey, submitKey]);

  const cleanScope = () => scopeUrls.map(value => value.trim()).filter(Boolean);
  const cleanCriteria = () => criteria.map(value => value.trim()).filter(Boolean);

  function buildDraftData(): DraftData {
    const data: DraftData = { environment, accessRequiresLogin, accessNotes: accessNotes.trim() };
    const target = targetUrl.trim();
    if (target) data.targetUrl = target;
    const urls = cleanScope();
    if (urls.length > 0) data.scopeUrls = urls;
    const list = cleanCriteria();
    if (list.length > 0) data.acceptanceCriteria = list;
    const focus = suggestions.trim();
    if (focus) data.suggestions = focus;
    const blocked = prohibitions.trim();
    if (blocked) data.prohibitions = blocked;
    if (picked.length > 0) data.deliverables = picked;
    return data;
  }

  function buildSubmission(): Submission {
    return {
      targetUrl: targetUrl.trim(),
      environment,
      scopeUrls: cleanScope(),
      acceptanceCriteria: cleanCriteria(),
      suggestions: suggestions.trim(),
      prohibitions: prohibitions.trim(),
      deliverables: picked,
      accessRequiresLogin,
      accessNotes: accessNotes.trim(),
    };
  }

  function stepIssue(index: number): string | null {
    if (index === 0) {
      if (!requestUrl.safeParse(targetUrl.trim()).success) return "Masukkan URL target HTTP(S) lengkap, tanpa kredensial atau fragmen.";
      const accessIssue = accessNotesIssue(accessNotes);
      if (accessIssue) return accessIssue;
      return null;
    }
    if (index === 1) {
      const urls = cleanScope();
      if (urls.length === 0) return "Pilih minimal satu URL cakupan, atau tambahkan URL manual.";
      if (urls.length > 12) return "Cakupan maksimal 12 URL.";
      for (const url of urls) {
        if (!scopeUrl.safeParse(url).success) return `URL cakupan belum valid: ${url}`;
      }
      if (new Set(urls.map(url => new URL(url).href)).size !== urls.length) return "Ada URL cakupan yang sama.";
      return null;
    }
    if (index === 2) {
      if (picked.length === 0) return "Pilih minimal satu deliverable.";
      const list = cleanCriteria();
      if (list.length === 0) return "Isi minimal satu kriteria penerimaan.";
      if (list.length > 10) return "Kriteria penerimaan maksimal 10.";
      if (list.some(item => item.length > 500)) return "Setiap kriteria penerimaan maksimal 500 karakter.";
      if (suggestions.trim().length > 2000) return "Saran maksimal 2.000 karakter.";
      if (prohibitions.trim().length > 2000) return "Larangan maksimal 2.000 karakter.";
      return null;
    }
    return null;
  }

  function focusHeading() {
    window.requestAnimationFrame(() => headingRef.current?.focus());
  }

  function goTo(index: number, skipValidation = false) {
    if (!skipValidation) {
      for (let cursor = 0; cursor < index; cursor++) {
        const issue = stepIssue(cursor);
        if (issue) {
          setStep(cursor);
          setStepError(issue);
          focusHeading();
          return;
        }
      }
    }
    setStep(index);
    setStepError("");
    focusHeading();
  }

  async function saveDraft(data: DraftData, silent = false): Promise<Draft | null> {
    if (saving) return null;
    const accessIssue = accessNotesIssue(accessNotes);
    if (accessIssue) {
      setSaveError(accessIssue);
      return null;
    }
    const parsed = draftDataSchema.safeParse(data);
    if (!parsed.success) {
      setSaveError("Isian draf belum sah. Periksa kembali sebelum menyimpan.");
      return null;
    }
    setSaving(true);
    setSaveError("");
    try {
      if (draftId && revision !== null) {
        const result = await call<{ draft: Draft }>(`/drafts/${encodeURIComponent(draftId)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ revision, data: parsed.data }),
        });
        setRevision(result.draft.revision);
        setSavedAt(result.draft.updatedAt);
        setConflict(false);
        if (!silent) setNotice({ kind: "info", text: "Draf tersimpan." });
        return result.draft;
      }
      const key = crypto.randomUUID();
      try { sessionStorage.setItem(pendingKey, JSON.stringify({ key, data: parsed.data } satisfies PendingDraft)); }
      catch { /* pemulihan tidak tersedia; penyimpanan tetap dicoba */ }
      const result = await call<{ draft: Draft }>("/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify(parsed.data),
      });
      try { sessionStorage.removeItem(pendingKey); } catch { /* abaikan */ }
      setPendingDraft(null);
      setDraftId(result.draft.draftId);
      setRevision(result.draft.revision);
      setSavedAt(result.draft.updatedAt);
      setConflict(false);
      try { window.history.replaceState(null, "", `/permintaan/${result.draft.draftId}`); }
      catch { /* URL tidak dapat diperbarui; draf tetap ada di daftar */ }
      if (!silent) setNotice({ kind: "info", text: "Draf tersimpan. Kamu bisa melanjutkannya nanti." });
      return result.draft;
    } catch (caught) {
      if (signal.aborted || onAuthFailure(caught)) return null;
      if (caught instanceof HttpError && caught.status === 409) {
        setConflict(true);
        setSaveError("Draf di server sudah berubah. Muat versi server sebelum menyimpan lagi.");
        return null;
      }
      if (caught instanceof HttpError && caught.status >= 400 && caught.status < 500) {
        try { sessionStorage.removeItem(pendingKey); } catch { /* abaikan */ }
        setPendingDraft(null);
        setSaveError(`Draf tidak tersimpan. ${errorText(caught)}`);
        return null;
      }
      setSaveError("Hasil penyimpanan belum pasti. Isian tetap di layar ini; simpan ulang untuk mencoba lagi.");
      try {
        const raw = sessionStorage.getItem(pendingKey);
        if (raw) setPendingDraft(JSON.parse(raw) as PendingDraft);
      } catch { /* pemulihan tidak tersedia */ }
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function replayPending() {
    if (!pendingDraft) return;
    setSaving(true);
    setSaveError("");
    try {
      const result = await call<{ draft: Draft }>("/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": pendingDraft.key },
        body: JSON.stringify(pendingDraft.data),
      });
      try { sessionStorage.removeItem(pendingKey); } catch { /* abaikan */ }
      setPendingDraft(null);
      setDraftId(result.draft.draftId);
      setRevision(result.draft.revision);
      setSavedAt(result.draft.updatedAt);
      setNotice({ kind: "info", text: "Draf tersimpan." });
    } catch (caught) {
      if (signal.aborted || onAuthFailure(caught)) return;
      setSaveError(`Draf masih belum tersimpan. ${errorText(caught)}`);
    } finally {
      setSaving(false);
    }
  }

  async function reloadFromServer() {
    if (!draftId) return;
    setSaving(true);
    setSaveError("");
    try {
      const result = await call<{ draft: Draft }>(`/drafts/${encodeURIComponent(draftId)}`);
      if (result.draft.jobId) {
        setSubmittedJobId(result.draft.jobId);
        setLoad("submitted");
        return;
      }
      // Pertahankan isian di layar; hanya revisi server yang diadopsi agar simpan berikutnya diterima.
      setRevision(result.draft.revision);
      setConflict(false);
      setNotice({ kind: "info", text: `Revisi server (${result.draft.revision}) diterapkan. Isian di layar dipertahankan; menyimpan akan menggantikan isi server dengan isian ini.` });
    } catch (caught) {
      if (signal.aborted || onAuthFailure(caught)) return;
      setSaveError(`Versi server belum dapat dimuat. ${errorText(caught)}`);
    } finally {
      setSaving(false);
    }
  }

  async function submitRequest() {
    if (busy) return;
    const accessIssue = accessNotesIssue(accessNotes);
    if (accessIssue) {
      setStep(0);
      setStepError(accessIssue);
      focusHeading();
      return;
    }
    const parsed = submissionSchema.safeParse(buildSubmission());
    if (!parsed.success) {
      const field = String(parsed.error.issues[0]?.path[0] ?? "");
      const target = field === "targetUrl" || field === "environment" || field === "accessRequiresLogin" || field === "accessNotes"
        ? 0
        : field === "scopeUrls" ? 1 : 2;
      setStep(target);
      setStepError("Periksa isian wajib sebelum mengirim permintaan.");
      focusHeading();
      return;
    }
    setBusy("submit");
    setSubmitError("");
    try {
      const saved = await saveDraft(parsed.data, true);
      if (!saved) {
        setBusy(null);
        return;
      }
      const result = await call<JobResponse>(`/drafts/${encodeURIComponent(saved.draftId)}/submit`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: saved.revision }),
      });
      try { sessionStorage.removeItem(submitKey); } catch { /* abaikan */ }
      setPendingSubmit(null);
      router.push(`/job/${result.job.jobId}`);
    } catch (caught) {
      if (signal.aborted || onAuthFailure(caught)) return;
      if (caught instanceof HttpError && caught.status === 409) {
        setConflict(true);
        setSubmitError("Draf sudah berubah di server. Muat versi server, lalu kirim lagi.");
      } else if (caught instanceof HttpError && caught.status >= 400 && caught.status < 500) {
        setSubmitError(`Permintaan belum terkirim. ${errorText(caught)}`);
      } else if (draftId && revision !== null) {
        const pending = { draftId, revision };
        setPendingSubmit(pending);
        try { sessionStorage.setItem(submitKey, JSON.stringify(pending)); } catch { /* abaikan */ }
        setSubmitError("Pengiriman belum terkonfirmasi. Permintaan mungkin sudah dibuat; konfirmasi ulang sebelum mencoba cara lain.");
      } else {
        setSubmitError("Pengiriman belum terkonfirmasi. Muat daftar permintaan untuk memeriksa hasilnya.");
      }
    } finally {
      setBusy(null);
    }
  }

  async function confirmSubmit(pending: PendingSubmit) {
    if (busy) return;
    setBusy("confirm");
    setSubmitError("");
    try {
      const result = await call<JobResponse>(`/drafts/${encodeURIComponent(pending.draftId)}/submit`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: pending.revision }),
      });
      try { sessionStorage.removeItem(submitKey); } catch { /* abaikan */ }
      setPendingSubmit(null);
      router.push(`/job/${result.job.jobId}`);
    } catch (caught) {
      if (signal.aborted || onAuthFailure(caught)) return;
      if (caught instanceof HttpError && caught.status === 409) {
        try { sessionStorage.removeItem(submitKey); } catch { /* abaikan */ }
        setPendingSubmit(null);
        setSubmitError("Permintaan ini tampaknya sudah dikirim, atau draf berubah di server. Buka daftar permintaan untuk memeriksa status terbaru sebelum mencoba lagi.");
      } else {
        setSubmitError(`Status pengiriman masih belum pasti. ${errorText(caught)}`);
      }
    } finally {
      setBusy(null);
    }
  }

  async function scan() {
    const target = targetUrl.trim();
    if (!requestUrl.safeParse(target).success) {
      setScanState("error");
      setScanMessage("Isi URL target yang valid di langkah pertama sebelum memindai.");
      return;
    }
    setScanState("running");
    setScanMessage("");
    try {
      const result = await call<{ candidates: string[] }>("/discovery", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ targetUrl: target }),
      });
      setCandidates(result.candidates);
      setScanState("done");
      setScanMessage(result.candidates.length > 0
        ? `${result.candidates.length} tautan publik ditemukan. Centang yang ingin diuji.`
        : "Tidak ada tautan publik yang bisa dipakai. Tambahkan URL manual.");
    } catch (caught) {
      if (signal.aborted || onAuthFailure(caught)) return;
      setCandidates([]);
      setScanState("error");
      const denied = caught instanceof HttpError && (caught.code === "DISCOVERY_TARGET_DENIED" || caught.code === "DISCOVERY_UNAVAILABLE");
      setScanMessage(denied
        ? "Halaman publik tidak dapat dipindai. Lanjutkan dengan URL manual di bawah."
        : `Pemindaian gagal. ${errorText(caught)} Kamu tetap bisa menambah URL manual.`);
    }
  }

  function isCandidateSelected(url: string) {
    const href = canonicalHref(url);
    return scopeUrls.some(item => item === url || (href !== null && canonicalHref(item.trim()) === href));
  }

  function toggleCandidate(url: string) {
    const href = canonicalHref(url);
    if (isCandidateSelected(url)) {
      setScopeUrls(scopeUrls.filter(item => item !== url && (href === null || canonicalHref(item.trim()) !== href)));
      setManualError("");
      return;
    }
    if (scopeUrls.length >= 12) {
      setManualError("Cakupan maksimal 12 URL.");
      return;
    }
    setScopeUrls([...scopeUrls, href ?? url]);
    setManualError("");
  }

  function addManual() {
    const resolved = resolveManualScopeUrl(manualUrl, targetUrl);
    if (!resolved.url) {
      if (resolved.error) setManualError(resolved.error);
      return;
    }
    if (scopeUrls.length >= 12) {
      setManualError("Cakupan maksimal 12 URL.");
      return;
    }
    const href = resolved.url;
    if (scopeUrls.some(item => canonicalHref(item.trim()) === href)) {
      setManualError("URL ini sudah ada di cakupan.");
      return;
    }
    setScopeUrls([...scopeUrls, href]);
    setManualUrl("");
    setManualError("");
  }

  function updateScope(index: number, value: string) {
    setScopeUrls(current => current.map((item, position) => position === index ? value : item));
  }

  function removeScope(index: number) {
    setScopeUrls(current => current.filter((_, position) => position !== index));
  }

  function updateCriterion(index: number, value: string) {
    setCriteria(current => current.map((item, position) => position === index ? value : item));
  }

  function addCriterion() {
    setCriteria(current => current.length >= 10 ? current : [...current, ""]);
  }

  function removeCriterion(index: number) {
    setCriteria(current => current.length === 1 ? [""] : current.filter((_, position) => position !== index));
  }

  function toggleDeliverable(kind: DeliverableKind) {
    setPicked(current => current.includes(kind) ? current.filter(item => item !== kind) : [...current, kind]);
  }

  if (load === "loading") return <main className="shell"><p className="empty" role="status">Memuat draf…</p></main>;

  if (load === "missing") return <main className="shell">
    <section className="panel auth-panel" aria-labelledby="missing-title">
      <p className="eyebrow">DRAF</p>
      <h1 id="missing-title">Draf tidak ditemukan</h1>
      <p className="auth-description">Draf ini tidak tersedia untuk akunmu, atau sudah dihapus. Draf hanya bisa dibuka oleh pemilik akun.</p>
      <div className="actions"><Link className="button button-primary" href="/">Kembali ke daftar</Link></div>
    </section>
  </main>;

  if (load === "error") return <main className="shell">
    <section className="panel auth-panel" aria-labelledby="error-title">
      <p className="eyebrow">DRAF</p>
      <h1 id="error-title">Draf belum dapat dimuat</h1>
      <p className="auth-description">{loadError}</p>
      <div className="actions"><button type="button" className="button button-quiet" onClick={() => window.location.reload()}>Coba lagi</button><Link className="button button-quiet" href="/">Kembali ke daftar</Link></div>
    </section>
  </main>;

  if (load === "submitted") return <main className="shell">
    <section className="panel auth-panel" aria-labelledby="submitted-title">
      <p className="eyebrow">DRAF</p>
      <h1 id="submitted-title">Draf sudah dikirim</h1>
      <p className="auth-description">Draf ini sudah menjadi permintaan QA dan tidak bisa diubah lagi. Pantau status dan hasilnya di halaman permintaan.</p>
      <div className="actions"><Link className="button button-primary" href={submittedJobId ? `/job/${submittedJobId}` : "/"}>Buka permintaan</Link><Link className="button button-quiet" href="/">Kembali ke daftar</Link></div>
    </section>
  </main>;

  return <main className="shell">
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">QA</span>
        <span className="brand-text"><strong>{draftId ? "Lanjutkan draf" : "Permintaan baru"}</strong><span>Empat langkah sebelum dikirim ke QA</span></span>
      </div>
      <div className="topbar-account"><Link className="link-button" href="/">Kembali ke daftar</Link></div>
    </header>

    {notice && <div className={`banner banner-${notice.kind === "error" ? "error" : "info"}`} role={notice.kind === "error" ? "alert" : "status"}>{notice.text}</div>}
    {saveError && <div className="banner banner-error" role="alert">
      <p>{saveError}</p>
      {conflict && draftId && <button type="button" className="button button-quiet" onClick={() => void reloadFromServer()} disabled={saving}>Muat versi server</button>}
    </div>}
    {pendingDraft && !draftId && <div className="banner banner-warn" role="status">
      <p><strong>Penyimpanan draf sebelumnya belum terkonfirmasi.</strong> Isian yang sama bisa disimpan ulang tanpa membuat draf ganda.</p>
      <button type="button" className="button button-quiet" onClick={() => void replayPending()} disabled={saving}>{saving ? "Menyimpan…" : "Simpan ulang draf"}</button>
    </div>}
    {pendingSubmit && <div className="banner banner-warn" role="alert">
      <p><strong>Pengiriman sebelumnya belum terkonfirmasi.</strong> Konfirmasi ulang memakai permintaan yang sama, jadi tidak membuat permintaan ganda.</p>
      <button type="button" className="button button-primary" onClick={() => void confirmSubmit(pendingSubmit)} disabled={busy !== null}>{busy === "confirm" ? "Memeriksa…" : "Konfirmasi pengiriman"}</button>
    </div>}
    {submitError && <div className="banner banner-error" role="alert">
      <p>{submitError}</p>
      <div className="actions">
        {conflict && draftId && <button type="button" className="button button-quiet" onClick={() => void reloadFromServer()} disabled={saving}>Muat versi server</button>}
        <Link className="link-button" href="/">Buka daftar permintaan</Link>
      </div>
    </div>}

    <div className="wizard">
      <nav className="wizard-rail" aria-label="Langkah formulir">
        <ol className="wizard-steps">
          {stepList.map((item, index) => <li key={item.title}>
            <button
              type="button"
              className="wizard-step"
              aria-current={index === step ? "step" : undefined}
              data-done={index < step ? "true" : undefined}
              onClick={() => goTo(index, index < step)}
            >
              <span className="step-num">{index + 1}</span>
              <span className="step-text"><strong>{item.title}</strong><span>{item.hint}</span></span>
            </button>
          </li>)}
        </ol>
        <p className="foot-note">Draf bisa disimpan kapan saja, termasuk saat baru terisi sebagian. Data disimpan di akunmu.</p>
      </nav>

      <section className="wizard-panel" aria-labelledby="step-title">
        <div className="step-head">
          <p className="eyebrow">LANGKAH {step + 1} DARI {stepList.length}</p>
          <h2 className="step-title" id="step-title" ref={headingRef} tabIndex={-1}>{stepList[step].title}</h2>
          <p className="step-lede">{
            step === 0 ? "Tentukan situs yang diuji dan konteks environment-nya. Kredensial tidak pernah disimpan di draf."
              : step === 1 ? "Pindai halaman publik untuk menemukan kandidat, lalu tambah URL manual bila ada yang terlewat."
                : step === 2 ? "Pilih hasil yang ingin diterima dan tuliskan fokus serta larangan pengujian."
                  : "Periksa ringkasan per bagian. Setelah dikirim, isi permintaan tidak bisa diubah."
          }</p>
        </div>

        {stepError && <p className="banner banner-error" role="alert">{stepError}</p>}

        {step === 0 && <div className="step-body">
          <div className="field">
            <label className="field-label" htmlFor="target">URL target <span className="required">*</span></label>
            <input
              id="target" className="input" type="url" inputMode="url" maxLength={2048}
              value={targetUrl} onChange={event => setTargetUrl(event.target.value)}
              placeholder="https://contoh.internal/aplikasi"
              aria-invalid={stepError ? true : undefined}
            />
            <p className="help">URL HTTP(S) lengkap tanpa nama pengguna, kata sandi, atau fragmen.</p>
          </div>

          <div className="field">
            <label className="field-label" htmlFor="environment">Environment</label>
            <select id="environment" className="input select" value={environment} onChange={event => setEnvironment(event.target.value as Submission["environment"])}>
              {environmentOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            <p className="help">Pilih konteks tempat pengujian dijalankan.</p>
          </div>

          <fieldset className="field access-field">
            <legend className="field-label">Kebutuhan akses</legend>
            <label className="check">
              <input type="checkbox" checked={accessRequiresLogin} onChange={event => setAccessRequiresLogin(event.target.checked)} />
              <span>Sebagian halaman perlu login untuk diuji</span>
            </label>
            <label className="field-label" htmlFor="access-notes">Petunjuk akses nonrahasia</label>
            <textarea
              id="access-notes" className="input textarea" rows={3} maxLength={1000}
              value={accessNotes} onChange={event => setAccessNotes(event.target.value)}
              placeholder="Contoh: minta akun uji pembeli lewat kanal internal; jangan ubah data pelanggan."
              aria-describedby={accessNotesIssue(accessNotes) ? "access-notes-help access-notes-error" : "access-notes-help"}
              aria-invalid={accessNotesIssue(accessNotes) ? true : undefined}
            />
            <p className="help" id="access-notes-help">
              Tersimpan di draf dan ikut ke tinjauan serta pengiriman ke agent QA. Jangan tulis kata sandi, token, atau kunci API di sini; isian seperti itu ditolak. Kredensial dikirim lewat jalur terpisah, bukan lewat formulir ini.
            </p>
            {accessNotesIssue(accessNotes) && <p className="error-text" id="access-notes-error" role="alert">{accessNotesIssue(accessNotes)}</p>}
            <p className="help counter">{accessNotes.trim().length} dari 1.000 karakter</p>
          </fieldset>
        </div>}

        {step === 1 && <div className="step-body">
          <div className="scan-row">
            <button type="button" className="button button-quiet" onClick={() => void scan()} disabled={scanState === "running"}>
              {scanState === "running" ? "Memindai…" : "Pindai halaman publik"}
            </button>
            <p className="help" role="status">{scanMessage || "Pemindaian hanya membaca halaman publik yang terlihat dan tidak mengirim permintaan QA."}</p>
          </div>

          {candidates.length > 0 && <fieldset className="field">
            <legend className="field-label">Kandidat dari pemindaian</legend>
            <ul className="candidate-list">
              {candidates.map(url => <li key={url}>
                <label className="check">
                  <input type="checkbox" checked={isCandidateSelected(url)} onChange={() => toggleCandidate(url)} />
                  <span className="mono">{url}</span>
                </label>
              </li>)}
            </ul>
          </fieldset>}

          <div className="field">
            <label className="field-label" htmlFor="manual-url">Tambah URL manual</label>
            <div className="inline-row">
              <input
                id="manual-url" className="input" type="text" inputMode="url" maxLength={2048}
                value={manualUrl} onChange={event => setManualUrl(event.target.value)}
                onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); addManual(); } }}
                placeholder="https://contoh.internal/halaman#fitur atau #fitur"
                aria-invalid={manualError ? true : undefined}
                aria-describedby={manualError ? "manual-help manual-error" : "manual-help"}
              />
              <button type="button" className="button button-quiet" onClick={addManual}>Tambah</button>
            </div>
            {manualError && <p className="error-text" id="manual-error" role="alert">{manualError}</p>}
            <p className="help" id="manual-help">URL manual selalu tersedia, termasuk saat pemindaian gagal atau hanya menemukan sebagian halaman. Mendukung URL lengkap dengan fragmen (#fitur) atau tulis #fitur untuk merujuk URL target.</p>
          </div>

          <fieldset className="field">
            <legend className="field-label">URL cakupan terpilih ({scopeUrls.length}/12)</legend>
            {scopeUrls.length === 0
              ? <p className="empty-inline">Belum ada URL. Centang kandidat atau tambahkan URL manual.</p>
              : <ul className="scope-list">
                {scopeUrls.map((url, index) => <li className="scope-row" key={`${url}-${index}`}>
                  <label className="visually-hidden" htmlFor={`scope-${index}`}>URL cakupan {index + 1}</label>
                  <input id={`scope-${index}`} className="input scope-input mono" value={url} onChange={event => updateScope(index, event.target.value)} maxLength={2048} />
                  <button type="button" className="button button-quiet" onClick={() => removeScope(index)}>Hapus</button>
                </li>)}
              </ul>}
            <p className="help">URL bisa diubah langsung. Perubahan pada URL hasil pemindaian memisahkannya dari kandidat.</p>
          </fieldset>
        </div>}

        {step === 2 && <div className="step-body">
          <fieldset className="field">
            <legend className="field-label">Deliverable yang diminta <span className="required">*</span></legend>
            <ul className="deliverable-grid">
              {(Object.keys(deliverableCatalog) as DeliverableKind[]).map(kind => <li key={kind}>
                <label className="deliverable">
                  <input type="checkbox" checked={picked.includes(kind)} onChange={() => toggleDeliverable(kind)} />
                  <span><strong>{deliverableCatalog[kind].label}</strong><span className="mono">.{deliverableCatalog[kind].extension}</span></span>
                </label>
              </li>)}
            </ul>
            <p className="help">Setiap deliverable dikirim sebagai satu file. Pilih minimal satu.</p>
          </fieldset>

          <fieldset className="field">
            <legend className="field-label">Kriteria penerimaan <span className="required">*</span></legend>
            <ul className="criteria-list">
              {criteria.map((value, index) => <li className="criterion-row" key={index}>
                <label className="visually-hidden" htmlFor={`criterion-${index}`}>Kriteria {index + 1}</label>
                <input id={`criterion-${index}`} className="input" value={value} maxLength={500} onChange={event => updateCriterion(index, event.target.value)} placeholder="Contoh: formulir menampilkan pesan validasi" />
                <button type="button" className="button button-quiet" onClick={() => removeCriterion(index)} aria-label={`Hapus kriteria ${index + 1}`}>Hapus</button>
              </li>)}
            </ul>
            <div className="inline-row">
              <button type="button" className="button button-quiet" onClick={addCriterion} disabled={criteria.length >= 10}>Tambah kriteria</button>
              <p className="help">{cleanCriteria().length} dari 10 kriteria, masing-masing maksimal 500 karakter.</p>
            </div>
          </fieldset>

          <div className="field">
            <label className="field-label" htmlFor="suggestions">Saran atau fokus pengujian</label>
            <textarea id="suggestions" className="input textarea" rows={3} maxLength={2000} value={suggestions} onChange={event => setSuggestions(event.target.value)} placeholder="Contoh: utamakan alur pendaftaran dan tampilan kosong." />
            <p className="help">Opsional, maksimal 2.000 karakter.</p>
          </div>

          <div className="field">
            <label className="field-label" htmlFor="prohibitions">Larangan pengujian</label>
            <textarea id="prohibitions" className="input textarea" rows={3} maxLength={2000} value={prohibitions} onChange={event => setProhibitions(event.target.value)} placeholder="Contoh: jangan melakukan transaksi atau mengubah data pelanggan." />
            <p className="help">Ditampilkan terpisah dari saran dan ikut dikirim ke agent QA.</p>
          </div>
        </div>}

        {step === 3 && <div className="step-body">
          <div className="review-grid">
            <section className="review-block" aria-labelledby="review-target">
              <div className="review-head"><h3 id="review-target">Target &amp; akses</h3><button type="button" className="link-button" onClick={() => goTo(0, true)}>Ubah</button></div>
              <dl className="summary-list">
                <div><dt>URL target</dt><dd className="mono">{targetUrl.trim() || "Belum diisi"}</dd></div>
                <div><dt>Environment</dt><dd>{environmentLabel(environment)}</dd></div>
                <div><dt>Kebutuhan akses</dt><dd>
                  <span className="tag">{accessRequiresLogin ? "Perlu login" : "Tanpa login"}</span>
                </dd></div>
                <div><dt>Petunjuk akses</dt><dd className="preserve-lines">{accessNotes.trim() || <span className="empty-inline">Tidak ada petunjuk tambahan.</span>}</dd></div>
              </dl>
            </section>

            <section className="review-block" aria-labelledby="review-scope">
              <div className="review-head"><h3 id="review-scope">Cakupan</h3><button type="button" className="link-button" onClick={() => goTo(1, true)}>Ubah</button></div>
              {cleanScope().length === 0 ? <p className="empty-inline">Belum ada URL cakupan.</p> : <ol className="scope-summary">
                {cleanScope().map(url => <li key={url} className="mono">{url}</li>)}
              </ol>}
            </section>

            <section className="review-block" aria-labelledby="review-deliverables">
              <div className="review-head"><h3 id="review-deliverables">Deliverable &amp; catatan</h3><button type="button" className="link-button" onClick={() => goTo(2, true)}>Ubah</button></div>
              <div className="tag-list review-tags">
                {picked.length === 0 ? <span className="empty-inline">Belum ada deliverable dipilih.</span>
                  : picked.map(kind => <span className="tag" key={kind}>{deliverableCatalog[kind].label}</span>)}
              </div>
              <dl className="summary-list">
                <div><dt>Kriteria penerimaan</dt><dd>{cleanCriteria().length === 0 ? "Belum diisi" : <ol className="scope-summary">{cleanCriteria().map((item, index) => <li key={index}>{item}</li>)}</ol>}</dd></div>
                <div><dt>Saran</dt><dd className="preserve-lines">{suggestions.trim() || "Tidak ada"}</dd></div>
                <div><dt>Larangan</dt><dd className="preserve-lines">{prohibitions.trim() || "Tidak ada"}</dd></div>
              </dl>
            </section>
          </div>

          <p className="banner banner-info">Setelah dikirim, permintaan dibekukan dan isinya tidak bisa diubah lagi. Pengiriman ke agent QA dilakukan dari halaman detail, dan hasil per deliverable bisa diunduh begitu tersedia.</p>
        </div>}

        <div className="wizard-foot">
          <div className="foot-left">
            {step > 0 && <button type="button" className="button button-quiet" onClick={() => goTo(step - 1, true)}>Kembali</button>}
          </div>
          <div className="foot-right">
            <button type="button" className="button button-quiet" onClick={() => void saveDraft(buildDraftData())} disabled={saving || busy !== null}>{saving ? "Menyimpan…" : "Simpan draf"}</button>
            {step < stepList.length - 1
              ? <button type="button" className="button button-primary" onClick={() => goTo(step + 1)}>Lanjut</button>
              : <button type="button" className="button button-primary" onClick={() => void submitRequest()} disabled={busy !== null || saving}>{busy === "submit" ? "Mengirim…" : "Kirim permintaan"}</button>}
          </div>
        </div>
        <p className="save-state" role="status">{savedAt ? `Draf tersimpan ${formatDateTime(savedAt)}` : "Draf belum disimpan"}</p>
      </section>
    </div>
  </main>;
}
