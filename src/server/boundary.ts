import "./only";
import { z } from "zod";
import { assert, Fault } from "./errors";
export function trustedHost(request: Request, origin: string): URL {
  const configured = new URL(origin);
  // Next may reconstruct request.url using an internal hostname/protocol. Host is the public authority.
  assert(request.headers.get("host") === configured.host, 403, "HOST_NOT_ALLOWED", "Host tidak diizinkan.");
  return configured;
}
export function trustedRequest(request: Request, origin: string) {
  const configured = trustedHost(request, origin);
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    assert(request.headers.get("origin") === configured.origin, 403, "ORIGIN_NOT_ALLOWED", "Origin tidak diizinkan.");
  }
}
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  assert(result.success, 400, "INVALID_REQUEST", "Field, tipe, atau batas nilai tidak sesuai kontrak.");
  return result.data;
}
export async function boundedBytes(request: Request | Response, limit: number): Promise<Buffer> {
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  if (reader) while (true) {
    const { value, done } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new Fault(413, "BODY_TOO_LARGE", "Body melebihi batas."); }
    chunks.push(value);
  }
  return Buffer.concat(chunks, size);
}
export async function rawJsonBody(request: Request): Promise<{ rawBytes: Buffer; json: unknown }> {
  assert(request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() === "application/json", 415, "JSON_REQUIRED", "Content-Type harus application/json.");
  const rawBytes = await boundedBytes(request, 65536);
  let json: unknown;
  try { json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBytes)); }
  catch { throw new Fault(400, "INVALID_JSON", "JSON tidak valid."); }
  return { rawBytes, json };
}
export async function body<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const { json } = await rawJsonBody(request);
  return parse(schema, json);
}
