"use client";

import { createContext, useContext, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import type { SessionResponse, SessionUser } from "@/contracts";
import { apiRequest, authStateFor, errorText } from "@/components/api-client";

type View = "loading" | "ready" | "login" | "forbidden" | "setup" | "error";

export type SessionContext = {
  user: SessionUser;
  signal: AbortSignal;
  onAuthFailure: (error: unknown) => boolean;
  onLogout: () => void;
};

const DashboardSession = createContext<SessionContext | null>(null);

export default function SessionGate({ children }: { children: (context: SessionContext) => ReactNode }) {
  const context = useContext(DashboardSession);
  return context ? <>{children(context)}</> : null;
}

export function DashboardSessionProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  // Login owns its session checks and invitation flow.
  const isLogin = pathname === "/login";

  const [view, setView] = useState<View>("loading");
  const [user, setUser] = useState<SessionUser | null>(null);
  const [notice, setNotice] = useState("");
  const seq = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  if (!controllerRef.current) controllerRef.current = new AbortController();

  const loadSession = useCallback(async () => {
    const current = ++seq.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setUser(null);
    setView("loading");
    try {
      const data = await apiRequest<SessionResponse>("/auth/session", { signal: controller.signal });
      if (current !== seq.current) return;
      setUser(data.user);
      setNotice("");
      setView("ready");
    } catch (error) {
      if (current !== seq.current || controller.signal.aborted) return;
      setNotice(errorText(error));
      setView(authStateFor(error) ?? "error");
    }
  }, []);

  useEffect(() => {
    if (isLogin) return;
    void loadSession();
    return () => { seq.current++; controllerRef.current?.abort(); };
  }, [isLogin, loadSession]);

  const onAuthFailure = useCallback((error: unknown) => {
    const next = authStateFor(error);
    if (!next) return false;
    seq.current++;
    controllerRef.current?.abort();
    setUser(null);
    setNotice(errorText(error));
    setView(next);
    return true;
  }, []);

  const onLogout = useCallback(async () => {
    seq.current++;
    controllerRef.current?.abort();
    setUser(null);
    setView("loading");
    setNotice("Menutup sesi…");
    try {
      await apiRequest<{ signedOut: true }>("/auth/logout", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      setView("login");
      setNotice("Sesi ditutup. Silakan masuk kembali.");
    } catch (error) {
      setView("error");
      setNotice(`Logout belum dapat dikonfirmasi. ${errorText(error)}`);
    }
  }, []);

  if (isLogin) return <>{children}</>;

  const controller = controllerRef.current;
  if (view === "ready" && user && controller) {
    return <DashboardSession.Provider value={{ user, signal: controller.signal, onAuthFailure, onLogout }}>{children}</DashboardSession.Provider>;
  }

  const title = view === "loading" ? "Memeriksa sesi…"
    : view === "login" ? "Sesi diperlukan"
      : view === "forbidden" ? "Akses belum diizinkan"
        : view === "setup" ? "Konfigurasi belum siap"
          : "Sesi belum dapat diperiksa";

  const description = view === "login" ? "Masuk dengan akun internal yang diundang operator untuk melihat permintaan QA milikmu."
    : view === "forbidden" ? "Akun ini belum aktif dalam daftar anggota Dashboard QA. Hubungi operator."
      : view === "setup" ? "Aplikasi memerlukan konfigurasi Supabase dan origin yang valid dari operator."
        : view === "error" ? "Tidak ada data permintaan yang ditampilkan sampai sesi terverifikasi."
          : "Menunggu respons layanan autentikasi.";

  return <main className="shell auth-shell">
    <section className="panel auth-panel" aria-labelledby="auth-title">
      <p className="eyebrow">DASHBOARD QA</p>
      <h1 id="auth-title">{title}</h1>
      <p className="auth-description">{description}</p>
      {notice && <p className="banner banner-error" role="alert">{notice}</p>}
      <div className="actions">
        {view === "login" && <a className="button button-primary" href="/login">Ke halaman masuk</a>}
        {view !== "loading" && <button type="button" className="button button-quiet" onClick={() => void loadSession()}>Periksa sesi lagi</button>}
      </div>
    </section>
  </main>;
}
