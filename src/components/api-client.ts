import { API_ROOT, type ApiError } from "@/contracts";

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_ROOT}${path}`, { ...init, credentials: "same-origin", cache: "no-store" });
  let body: unknown;
  try { body = await response.json(); }
  catch { throw new Error("Respons server tidak dapat dibaca. Periksa status terbaru sebelum mengulang aksi."); }
  if (!response.ok) {
    const fault = (body as Partial<ApiError>)?.error;
    throw new HttpError(response.status, fault?.code ?? "HTTP_ERROR", fault?.message ?? `Permintaan gagal (${response.status}).`);
  }
  return body as T;
}

export function errorText(error: unknown): string {
  if (error instanceof HttpError) return `${error.message} (${error.code})`;
  if (error instanceof Error && (error.message.startsWith("Respons server") || error.message.startsWith("Respons detail"))) return error.message;
  return "Koneksi ke layanan gagal. Data yang tampil mungkin sudah berubah.";
}

export function authStateFor(error: unknown): "login" | "forbidden" | "setup" | null {
  if (!(error instanceof HttpError)) return null;
  if (error.status === 401) return "login";
  if (error.status === 403 && error.code === "MEMBERSHIP_REQUIRED") return "forbidden";
  if (error.status === 503 && error.code === "SETUP_REQUIRED") return "setup";
  return null;
}
