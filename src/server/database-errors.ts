import "./only";
import { Fault } from "./errors";
const known = new Set([
  "AUTH_REQUIRED", "MEMBERSHIP_REQUIRED", "INVALID_REQUEST", "INVALID_CALLBACK", "INVALID_CHECKS",
  "JOB_NOT_FOUND", "IDEMPOTENCY_CONFLICT", "DISPATCH_IN_PROGRESS", "TERMINAL_JOB", "ACTION_NOT_ALLOWED",
  "ATTEMPT_NOT_FOUND", "EXECUTION_MISMATCH", "RECEIVER_CONFLICT", "DISPATCH_REQUIRED", "EXECUTION_NOT_FOUND",
  "EVENT_CONFLICT", "EVENT_NOT_FOUND", "TERMINAL_CONFLICT", "RECEIPT_REQUIRED",
]);
export function databaseFault(error: { code?: string; message?: string }): Fault {
  const code = error.message ?? "";
  const status = error.code?.match(/^PT(400|401|403|404|409)$/)?.[1];
  const messages: Record<string, string> = {
    AUTH_REQUIRED: "Sesi berakhir. Silakan login kembali.", MEMBERSHIP_REQUIRED: "Akun belum diizinkan mengakses Dashboard QA.",
    DISPATCH_IN_PROGRESS: "Permintaan lain sedang berjalan. Tunggu lease berakhir lalu rekonsiliasi.",
    IDEMPOTENCY_CONFLICT: "Key sudah digunakan untuk payload berbeda.",
  };
  if (status && known.has(code)) return new Fault(Number(status), code, messages[code] ?? (status === "404" ? "Data tidak ditemukan." : "Operasi ditolak oleh aturan data. Muat ulang status job."));
  if (["42501", "PGRST301", "PGRST302", "PGRST303"].includes(error.code ?? "")) return new Fault(403, "ACCESS_DENIED", "Akses data ditolak. Periksa sesi dan izin akun.");
  return new Fault(503, "DATABASE_UNAVAILABLE", "Layanan data atau migrasi belum siap. Muat ulang sebelum mencoba lagi.");
}
