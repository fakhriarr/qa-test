import "./only";
import { Fault } from "./errors";
const known = new Set([
  "AUTH_REQUIRED", "UNAUTHORIZED_CALLBACK", "MEMBERSHIP_REQUIRED", "INVALID_REQUEST", "INVALID_CALLBACK", "INVALID_CHECKS",
  "JOB_NOT_FOUND", "IDEMPOTENCY_CONFLICT", "DISPATCH_IN_PROGRESS", "TERMINAL_JOB", "ACTION_NOT_ALLOWED",
  "ATTEMPT_NOT_FOUND", "EXECUTION_MISMATCH", "RECEIVER_CONFLICT", "DISPATCH_REQUIRED", "EXECUTION_NOT_FOUND",
  "DRAFT_NOT_FOUND", "DRAFT_CONFLICT", "ARTIFACT_NOT_FOUND", "ARTIFACT_CONFLICT", "ARTIFACT_VERSION_CONFLICT", "ARTIFACT_NOT_READY", "ARTIFACT_EXECUTION_INACTIVE", "ARTIFACT_STORAGE_UNAVAILABLE",
  "TEST_RUN_NOT_FOUND", "TEST_RUN_IN_PROGRESS", "TEST_RUN_NOT_RUNNING",
  "EVENT_CONFLICT", "EVENT_NOT_FOUND", "TERMINAL_CONFLICT", "RECEIPT_REQUIRED",
]);
export function databaseFault(error: { code?: string; message?: string }): Fault {
  const code = error.message ?? "";
  const status = error.code?.match(/^PT(400|401|403|404|409|503)$/)?.[1];
  const messages: Record<string, string> = {
    AUTH_REQUIRED: "Sesi berakhir. Silakan login kembali.", UNAUTHORIZED_CALLBACK: "Autentikasi callback tidak valid.",
    MEMBERSHIP_REQUIRED: "Akun belum diizinkan mengakses Dashboard QA.",
    DISPATCH_IN_PROGRESS: "Permintaan lain sedang berjalan. Tunggu lease berakhir lalu rekonsiliasi.",
    IDEMPOTENCY_CONFLICT: "Key sudah digunakan untuk payload berbeda.",
    ARTIFACT_VERSION_CONFLICT: "Versi aktif deliverable sudah berubah. Muat ulang versi terbaru sebelum mengunggah revisi.",
    ARTIFACT_NOT_READY: "Deliverable belum memiliki file awal yang siap direvisi.",
    TEST_RUN_NOT_FOUND: "Sesi pengujian tidak ditemukan.",
    TEST_RUN_IN_PROGRESS: "Sesi pengujian sedang berjalan. Tunggu sampai selesai.",
    TEST_RUN_NOT_RUNNING: "Sesi pengujian tidak berada dalam status berjalan.",
  };
  if (status && known.has(code)) return new Fault(Number(status), code, messages[code] ?? (status === "404" ? "Data tidak ditemukan." : "Operasi ditolak oleh aturan data. Muat ulang status job."));
  if (["42501", "PGRST301", "PGRST302", "PGRST303"].includes(error.code ?? "")) return new Fault(403, "ACCESS_DENIED", "Akses data ditolak. Periksa sesi dan izin akun.");
  return new Fault(503, "DATABASE_UNAVAILABLE", "Layanan data atau migrasi belum siap. Muat ulang sebelum mencoba lagi.");
}
