import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createJobSchema, callbackSchema, loginSchema, passwordSchema, canReconcile, isTerminal, type Job } from "../src/contracts";
import { readConfig } from "../src/server/config";
import { body, trustedRequest } from "../src/server/boundary";
import { Fault } from "../src/server/errors";
import { databaseFault } from "../src/server/database-errors";

const fixture = { schemaVersion: 1 as const, targetUrl: "https://example.invalid/qa-demo", scope: "Dummy only", acceptanceCriteria: ["Dummy criterion"], deliverables: ["summary", "checks", "findings"] };
const origin = "https://qa.example.invalid";
const fails = (fn: () => unknown, code: string) => assert.throws(fn, (e: unknown) => e instanceof Fault && e.code === code);

test("create validation: valid dummy, no extra fields, bounds, credential URL, exact deliverables", () => {
  assert.equal(createJobSchema.safeParse(fixture).success, true);
  for (const input of [{ ...fixture, credentials: "dummy" }, { ...fixture, scope: "\t" }, { ...fixture, targetUrl: "file:///tmp/unused" }, { ...fixture, targetUrl: "https://user:dummy@example.invalid" }, { ...fixture, acceptanceCriteria: [] }, { ...fixture, acceptanceCriteria: ["x".repeat(501)] }, { ...fixture, deliverables: ["summary","summary","checks"] }]) assert.equal(createJobSchema.safeParse(input).success, false);
});

test("callback shape/sequence and login schemas (no network or persistence)", () => {
  const e = { schemaVersion: 1, mode: "simulation", eventId: randomUUID(), jobId: randomUUID(), executionId: randomUUID(), sequence: 1, eventType: "running", result: null, error: null };
  assert.equal(callbackSchema.safeParse(e).success, true);
  assert.equal(callbackSchema.safeParse({ ...e, sequence: 2 }).success, false);
  assert.equal(loginSchema.safeParse({ email: "member@example.invalid", password: "dummy-example-only" }).success, true);
  assert.equal(loginSchema.safeParse({ email: "member@example.invalid", password: "dummy", role: "admin" }).success, false);
  assert.equal(passwordSchema.safeParse({ password: "short" }).success, false);
});

test("trusted Host passes with a reconstructed internal Next URL; forwarded headers are ignored", () => {
  const request = new Request("http://internal-next:3000/api/v1/jobs", { method: "POST", headers: { Host: "qa.example.invalid", Origin: origin, "X-Forwarded-Host": "attacker.invalid" } });
  trustedRequest(request, origin);
  fails(() => trustedRequest(new Request("http://internal-next:3000/api/v1/jobs", { headers: { Host: "attacker.invalid", "X-Forwarded-Host": "qa.example.invalid" } }), origin), "HOST_NOT_ALLOWED");
  for (const value of ["https://qa.example.invalid.attacker.invalid", "null", "https://other.example.invalid"]) fails(() => trustedRequest(new Request("http://internal/api", { method: "POST", headers: { Host: "qa.example.invalid", Origin: value } }), origin), "ORIGIN_NOT_ALLOWED");
  fails(() => trustedRequest(new Request("http://internal/api", { method: "POST", headers: { Host: "qa.example.invalid" } }), origin), "ORIGIN_NOT_ALLOWED");
});

test("missing configuration fails closed; no admin key or dashboard URL accepted", () => {
  fails(() => readConfig({}), "SETUP_REQUIRED");
  // Deliberately invalid example configuration; never supplied to a client or a build.
  fails(() => readConfig({ NEXT_PUBLIC_SUPABASE_URL: "https://supabase.com/dashboard/project/example", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "example", QA_APP_ORIGIN: origin }), "SETUP_REQUIRED");
  fails(() => readConfig({ NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_secret_example", QA_APP_ORIGIN: origin }), "SETUP_REQUIRED");
});

test("request JSON boundary: malformed/unknown, media type and actual streamed byte limit", async () => {
  const request = (value: string, type = "application/json") => new Request(origin + "/api/v1/jobs", { method: "POST", headers: { "Content-Type": type }, body: value });
  assert.deepEqual(await body(request(JSON.stringify(fixture)), createJobSchema), fixture);
  await assert.rejects(body(request("{"), createJobSchema), (e: unknown) => e instanceof Fault && e.status === 400);
  await assert.rejects(body(request("{}", "text/plain"), createJobSchema), (e: unknown) => e instanceof Fault && e.status === 415);
  await assert.rejects(body(request(" ".repeat(65537)), createJobSchema), (e: unknown) => e instanceof Fault && e.status === 413);
});

test("reconcile affordance: no terminal execution or active lease; expired sending recoverable", () => {
  const j = { executionStatus: "running", deliveryStatus: "accepted", leaseExpiresAt: null } as Job;
  assert.equal(canReconcile(j), true);
  assert.equal(canReconcile({ ...j, executionStatus: "succeeded" }), false); assert.equal(isTerminal({ ...j, executionStatus: "failed" }), true);
  assert.equal(canReconcile({ ...j, deliveryStatus: "unknown", leaseExpiresAt: "2099-01-01T00:00:00Z" }, Date.parse("2026-01-01T00:00:00Z")), false);
  assert.equal(canReconcile({ ...j, deliveryStatus: "sending", leaseExpiresAt: "2026-01-01T00:00:00Z" }, Date.parse("2026-01-01T00:01:00Z")), true);
});

test("database errors use a safe allowlist without copying provider messages", () => {
  assert.equal(databaseFault({ code: "PT409", message: "IDEMPOTENCY_CONFLICT" }).status, 409);
  const error = databaseFault({ code: "unexpected", message: "private provider details" });
  assert.equal(error.status, 503); assert.equal(error.message.includes("private provider"), false);
});
