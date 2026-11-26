"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { loginSchema, passwordSchema, type SessionResponse } from "@/contracts";
import { apiRequest, authStateFor, errorText, HttpError } from "@/components/api-client";

type View = "loading" | "login" | "invited" | "ready" | "forbidden" | "setup" | "error";

export default function LoginPage() {
  const [view, setView] = useState<View>("loading");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    const invited = new URLSearchParams(window.location.search).get("invited") === "1";
    void apiRequest<SessionResponse>("/auth/session", { signal: controller.signal }).then(data => {
      if (controller.signal.aborted) return;
      setEmail(data.user.email ?? "");
      setView(invited ? "invited" : "ready");
    }).catch(error => {
      if (controller.signal.aborted) return;
      const state = authStateFor(error);
      setView(state === "forbidden" ? "forbidden" : state === "setup" ? "setup" : state === "login" ? "login" : "error");
      if (state !== "login") setMessage(errorText(error));
      if (invited && state === "login") setMessage("Sesi undangan tidak tersedia atau sudah berakhir. Hubungi operator untuk undangan baru.");
    });
    return () => { controller.abort(); controllerRef.current = null; };
  }, []);

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyRef.current) return;
    const input = loginSchema.safeParse({ email: email.trim(), password });
    if (!input.success) { setMessage("Masukkan email valid dan password akun undangan."); return; }
    busyRef.current = true;
    setBusy(true);
    setMessage("");
    try {
      await apiRequest<SessionResponse>("/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input.data),
        signal: controllerRef.current?.signal,
      });
      setPassword("");
      window.location.assign("/");
    } catch (error) {
      if (controllerRef.current?.signal.aborted) return;
      const state = authStateFor(error);
      if (state === "forbidden" || state === "setup") setView(state);
      setMessage(error instanceof HttpError && error.status === 401 ? "Login gagal. Periksa akun atau hubungi operator." : errorText(error));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function handlePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyRef.current) return;
    if (!passwordSchema.safeParse({ password: newPassword }).success || newPassword !== confirmPassword) {
      setMessage("Password baru minimal 12 karakter dan kedua isian harus sama.");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setMessage("");
    try {
      await apiRequest<{ updated: true }>("/auth/password", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: newPassword }),
        signal: controllerRef.current?.signal,
      });
      setNewPassword("");
      setConfirmPassword("");
      window.location.assign("/");
    } catch (error) {
      if (controllerRef.current?.signal.aborted) return;
      const state = authStateFor(error);
      if (state === "login" || state === "forbidden" || state === "setup") setView(state);
      setMessage(errorText(error));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return <main className="shell auth-shell">
    <section className="panel auth-panel" aria-labelledby="login-title">
      <p className="eyebrow">AKSES INTERNAL / DASHBOARD QA</p>
      <h1 id="login-title">{view === "login" ? "Masuk ke dashboard" : view === "invited" ? "Atur password undangan" : view === "ready" ? "Sesi sudah aktif" : view === "forbidden" ? "Akses belum diizinkan" : view === "setup" ? "Konfigurasi belum siap" : view === "error" ? "Sesi belum dapat diperiksa" : "Memeriksa sesi…"}</h1>
      <p className="auth-description">{view === "login" ? "Gunakan akun yang diundang operator. Pendaftaran publik tidak tersedia." : view === "invited" ? "Buat password baru untuk akun undangan. Password hanya dikirim ke endpoint Auth aplikasi." : view === "ready" ? "Akunmu sudah terverifikasi. Lanjutkan ke dashboard." : view === "forbidden" ? "Akun ini belum aktif dalam daftar anggota. Hubungi operator." : view === "setup" ? "Operator perlu mengatur Supabase dan origin aplikasi sebelum login dapat dipakai." : "Data dashboard tetap tersembunyi sampai sesi terverifikasi."}</p>
      {message && <p className="notice notice-error" role="alert">{message}</p>}

      {view === "login" && <form onSubmit={handleLogin} noValidate>
        <label className="field-label" htmlFor="login-email">Email</label>
        <input id="login-email" className="input" type="email" autoComplete="username" value={email} onChange={event => setEmail(event.target.value)} required maxLength={254} />
        <label className="field-label" htmlFor="login-password">Password</label>
        <input id="login-password" className="input" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required />
        <p className="field-help">Belum punya password? Minta tautan undangan ke operator. Pendaftaran mandiri tidak tersedia.</p>
        <button className="button button-primary auth-submit" type="submit" disabled={busy}>{busy ? "Memeriksa akun…" : "Masuk"}</button>
      </form>}

      {view === "invited" && <form onSubmit={handlePassword} noValidate>
        {email && <p className="account-hint">Akun: {email}</p>}
        <label className="field-label" htmlFor="new-password">Password baru</label>
        <input id="new-password" className="input" type="password" autoComplete="new-password" value={newPassword} onChange={event => setNewPassword(event.target.value)} required minLength={12} />
        <label className="field-label" htmlFor="confirm-password">Ulangi password baru</label>
        <input id="confirm-password" className="input" type="password" autoComplete="new-password" value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} required minLength={12} />
        <p className="field-help">Minimal 12 karakter; kebijakan Supabase dapat mensyaratkan lebih.</p>
        <button className="button button-primary auth-submit" type="submit" disabled={busy}>{busy ? "Menyimpan…" : "Simpan password"}</button>
      </form>}

      <div className="actions auth-actions">{view === "ready" && <a className="button button-primary" href="/">Buka dashboard</a>}{view === "error" && <button className="button button-quiet" type="button" onClick={() => window.location.reload()}>Coba periksa lagi</button>}{(view === "forbidden" || view === "setup") && <a className="button button-quiet" href="/">Periksa sesi</a>}</div>
      <p className="fineprint">Akses internal untuk mengirim permintaan pengujian ke agent QA OpenBot dan memantau hasilnya.</p>
    </section>
  </main>;
}
