import { test } from "node:test";
import assert from "node:assert/strict";
import { ARTIFACT_MAX_BYTES, deliverableCatalog, draftDataSchema, requestUrl, scopeUrl, submissionSchema } from "../src/contracts/requests";
import { validArtifact } from "../src/server/artifact-format";
import { discoverLinks, visibleLinkCandidates } from "../src/server/discovery";
import {
  artifactPath, artifactRevisionPath, artifactToken, artifactVersionDownloadPath,
  deliverableProgress, downloadArtifact, revisionStorageCapability, storageCapability, uploadArtifactRevision,
} from "../src/server/artifacts";
import { buildOpenBotDispatchRequest } from "../src/server/webhook";

const complete = {
  targetUrl: "https://shop.example/",
  environment: "staging",
  scopeUrls: ["https://shop.example/cart"],
  acceptanceCriteria: ["Keranjang kosong menampilkan pesan yang jelas."],
  deliverables: ["test_plan", "test_case", "automation_script"],
};

test("partial drafts can be stored without becoming valid submissions", () => {
  const partial = { targetUrl: "https:", acceptanceCriteria: [""] };
  assert.deepEqual(draftDataSchema.parse(partial), partial);
  assert.equal(submissionSchema.safeParse(partial).success, false);
  assert.equal(draftDataSchema.safeParse({ ...partial, password: "synthetic-value" }).success, false);
  assert.equal(submissionSchema.parse(complete).suggestions, "");
  assert.equal(submissionSchema.safeParse({ ...complete, scopeUrls: ["https://shop.example", "https://shop.example/"] }).success, false);
  assert.equal(submissionSchema.safeParse({ ...complete, scopeUrls: ["https://test:value@shop.example/"] }).success, false);
  assert.equal(Object.keys(deliverableCatalog).length, 7);
});

test("discovery returns same-origin page and anchor candidates without navigation", () => {
  const html = `<!doctype html><html><head><title>shop</title></head><body>
    <a href="/">Beranda</a><a href="#">Menu kosong</a>
    <a href="#fitur">Fitur</a><a href="/#fitur">Fitur duplikat</a><a href=" #kontak ">Kontak</a>
    <a href="/cart">Keranjang</a><a href="/cart#total">Total</a>
    <a href="/docs#fitur">Dokumentasi Fitur</a><a href="/docs#api">Dokumentasi API</a><a href="/docs#">Dokumentasi</a>
    <a href="https://elsewhere.example/#fitur">External Anchor</a>
    <a href="https://elsewhere.example/checkout">External</a>
    <div hidden><a href="#tersembunyi">Hidden Anchor</a><a href="/hidden">Hidden</a></div>
    <script>const sample = '<a href="#script">Ignored</a><a href="/script">Ignored</a>';</script>
    <!-- <a href="#comment">Ignored</a> -->
    <a download href="/export.csv">Download</a><a href="/help?a=1&amp;b=2#faq">Bantuan FAQ</a>
    </body></html>`;
  assert.deepEqual(visibleLinkCandidates(html, new URL("https://shop.example/")), [
    "https://shop.example/#fitur",
    "https://shop.example/#kontak",
    "https://shop.example/cart",
    "https://shop.example/cart#total",
    "https://shop.example/docs#fitur",
    "https://shop.example/docs#api",
    "https://shop.example/docs",
    "https://shop.example/help?a=1&b=2#faq",
  ]);
});

test("targetUrl stays fragment-free while scopeUrls preserve distinct anchors through draft, submit and dispatch", async () => {
  assert.equal(requestUrl.safeParse("https://shop.example/").success, true);
  assert.equal(requestUrl.safeParse("https://shop.example/#fitur").success, false);
  assert.equal(requestUrl.safeParse("https://shop.example/#").success, false);
  await assert.rejects(discoverLinks("https://shop.example/#fitur"), { code: "DISCOVERY_TARGET_DENIED" });

  assert.equal(scopeUrl.safeParse("https://shop.example/#fitur").success, true);
  assert.equal(scopeUrl.safeParse("https://shop.example/docs#fitur").success, true);
  assert.equal(scopeUrl.safeParse("https://shop.example/#/spa-route").success, true);
  assert.equal(scopeUrl.safeParse("https://shop.example/#").success, false);
  assert.equal(scopeUrl.safeParse("https://shop.example/#dua#fragmen").success, false);
  assert.equal(scopeUrl.safeParse("https://user:value@shop.example/#fitur").success, false);

  const anchored = {
    ...complete,
    scopeUrls: [
      "https://shop.example/#fitur",
      "https://shop.example/#kontak",
      "https://shop.example/docs#fitur",
    ],
  };
  assert.deepEqual(draftDataSchema.parse(anchored).scopeUrls, anchored.scopeUrls);
  const parsed = submissionSchema.parse(anchored);
  assert.deepEqual(parsed.scopeUrls, anchored.scopeUrls);
  assert.equal(submissionSchema.safeParse({ ...anchored, targetUrl: "https://shop.example/#fitur" }).success, false);
  assert.equal(submissionSchema.safeParse({
    ...complete,
    scopeUrls: ["https://shop.example#fitur", "https://shop.example/#fitur"],
  }).success, false);

  const dispatched = buildOpenBotDispatchRequest({
    appOrigin: "https://qa.example.invalid",
    webhookConfig: {
      webhookUrl: "https://webhook.example.invalid/hook",
      webhookSecret: "synthetic-webhook-secret",
      callbackKeyMaterial: new Uint8Array(32),
    },
    job: {
      schemaVersion: 1,
      jobId: "11111111-1111-4111-8111-111111111111",
      executionId: "22222222-2222-4222-8222-222222222222",
      mode: "simulation",
      targetUrl: parsed.targetUrl,
      scope: "Cakupan permintaan QA tersimpan di request.scopeUrls.",
      acceptanceCriteria: parsed.acceptanceCriteria,
      deliverables: ["summary", "checks", "findings"],
      createdAt: "2026-11-27T03:00:00.000Z",
      updatedAt: "2026-11-27T03:00:00.000Z",
      version: 1,
      deliveryStatus: "sending",
      executionStatus: "not_started",
      lastError: null,
      result: null,
      leaseExpiresAt: null,
    },
    callbackToken: "0".repeat(64),
    requestDetails: {
      environment: parsed.environment,
      accessRequiresLogin: parsed.accessRequiresLogin,
      accessNotes: parsed.accessNotes,
      scopeUrls: parsed.scopeUrls,
      suggestions: parsed.suggestions,
      prohibitions: parsed.prohibitions,
      securityPolicy: "defensive_only",
      deliverables: [],
    },
  });
  assert.equal(dispatched.payload.data.targetUrl, "https://shop.example/");
  assert.deepEqual(dispatched.payload.data.request?.scopeUrls, anchored.scopeUrls);
});

test("artifact format gates accept inert Markdown, CSV and a single-entry ZIP", () => {
  const markdown = Buffer.from("# Synthetic plan\n\nCheck the empty state.\n");
  const csv = Buffer.from('id,expected\n1,"Cart, empty"\n');
  // Structurally valid ZIP containing a zero-byte note.txt.
  const archive = Buffer.from(
    "504b030414000000000000002100000000000000000000000000080000006e6f74652e747874" +
    "504b010214031400000000000000210000000000000000000000000008000000000000000000" +
    "00008001000000006e6f74652e747874504b0506000000000100010036000000260000000000", "hex",
  );
  assert.equal(validArtifact("test_plan", "plan.md", markdown), true);
  assert.equal(validArtifact("test_case", "cases.csv", csv), true);
  assert.equal(validArtifact("automation_script", "script.zip", archive), true);
  assert.equal(validArtifact("test_case", "cases.csv", Buffer.from('id,expected\n1,"unclosed')), false);
  assert.equal(validArtifact("test_plan", "../plan.md", markdown), false);
  assert.equal(validArtifact("automation_script", "script.zip", Buffer.from("PK")), false);
  assert.equal(ARTIFACT_MAX_BYTES, 3_145_728);
});

test("artifact route identifies an execution and token is scoped to its item", () => {
  assert.equal(artifactPath("job", "execution", "second"),
    "/api/v1/callbacks/qa/job/executions/execution/deliverables/second");
  const first = artifactToken("synthetic-execution-token", "first");
  assert.equal(first, artifactToken("synthetic-execution-token", "first"));
  assert.notEqual(first, artifactToken("synthetic-execution-token", "second"));
  assert.notEqual(first, artifactToken("different-execution-token", "first"));
});


test("access metadata stays optional and rejects credential-shaped fields or notes", () => {
  const access = { accessRequiresLogin: true, accessNotes: "Minta akun uji lewat kanal internal." };
  assert.deepEqual(draftDataSchema.parse(access), access);
  assert.equal(submissionSchema.parse(complete).accessRequiresLogin, false);
  assert.equal(submissionSchema.parse(complete).accessNotes, "");
  assert.equal(submissionSchema.parse({ ...complete, ...access }).accessNotes, access.accessNotes);
  assert.equal(draftDataSchema.safeParse({ accessRequiresLogin: "true" }).success, false);
  assert.equal(draftDataSchema.safeParse({ accessNotes: "password=synthetic-example" }).success, false);
  assert.equal(draftDataSchema.safeParse({ accessNotes: "https://name:sample@shop.example" }).success, false);
  assert.equal(draftDataSchema.safeParse({ accessNotes: "x".repeat(1001) }).success, false);
});

test("internal Storage capability is separate and scoped to job, execution and item", () => {
  const key = Buffer.from("synthetic-key");
  const cap = storageCapability(key, "job", "execution", "item");
  assert.notEqual(cap, storageCapability(key, "other-job", "execution", "item"));
  assert.notEqual(cap, storageCapability(key, "job", "other-execution", "item"));
  assert.notEqual(cap, storageCapability(key, "job", "execution", "other-item"));
  assert.notEqual(cap, artifactToken("synthetic-key", "item"));
});

test("downloads verified CSV from the authenticated Storage endpoint", async (t) => {
  const { createHash } = await import("node:crypto");
  const csv = "case,expected\nLogin,success\n";
  const row = {
    owner_id: "owner", job_id: "job", execution_id: "execution", deliverable_id: "item",
    file_name: "cases.csv", kind: "test_case", size_bytes: Buffer.byteLength(csv),
    sha256: createHash("sha256").update(csv).digest("hex"),
  };
  const filters: Record<string, string> = {};
  const query = {
    select: () => query,
    eq: (key: string, value: string) => { filters[key] = value; return query; },
    not: () => query,
    maybeSingle: async () => ({ data: filters.owner_id === "owner" ? row : null, error: null }),
  };
  const client = {
    from: () => query,
    auth: { getSession: async () => ({ data: { session: { user: { id: "owner" }, access_token: "synthetic-token" } }, error: null }) },
  } as unknown as Parameters<typeof downloadArtifact>[0];
  const config = { supabaseUrl: "https://storage.example", publishableKey: "test-key", origin: "https://app.example" };
  const fetchMock = t.mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
    assert.equal(url.pathname, "/storage/v1/object/authenticated/qa-deliverables/owner/job/execution/item");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer synthetic-token");
    return new Response(csv);
  });
  await assert.rejects(downloadArtifact(client, config, "other", "job", "item"), { code: "ARTIFACT_NOT_FOUND" });
  assert.equal(fetchMock.mock.callCount(), 0);
  const response = await downloadArtifact(client, config, "owner", "job", "item");
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="cases.csv"');
  assert.equal(await response.text(), csv);
});

test("revision paths and storage capabilities are isolated per item and grant token hash", () => {
  assert.equal(
    artifactRevisionPath("job", "exec", "item"),
    "/api/v1/callbacks/qa/job/executions/exec/deliverables/item/revisions",
  );
  assert.equal(
    artifactVersionDownloadPath("job", "item", "ver-1"),
    "/api/v1/jobs/job/deliverables/item/versions/ver-1",
  );
  const key = Buffer.from("synthetic-key");
  const hashA = "a".repeat(64);
  const hashB = "b".repeat(64);
  const cap = revisionStorageCapability(key, "job", "exec", "item", hashA);
  assert.notEqual(cap, storageCapability(key, "job", "exec", "item"));
  assert.notEqual(cap, revisionStorageCapability(key, "job", "exec", "item", hashB));
  assert.notEqual(cap, revisionStorageCapability(key, "job", "exec", "other-item", hashA));
});

test("explicit revision upload validates format/checksum, activates atomically, deduplicates retries, and preserves active on failure", async () => {
  const { createHash } = await import("node:crypto");
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const csvV1 = "id,expected\n1,Login berhasil\n";
  const csvV2 = "id,expected\n1,Login berhasil\n2,Validasi kosong\n3,Logout aman\n";
  const token = "c".repeat(64);
  const key = new Uint8Array(32).fill(7);
  const config = { supabaseUrl: "https://storage.example", publishableKey: "sb_publishable_test", origin: "https://app.example" };

  let activeVersionNumber = 1;
  let activeVersionId = "11111111-1111-4111-8111-111111111111";
  let storageFail = false;
  const versions = new Map<string, {
    version_id: string; deliverable_id: string; owner_id: string; job_id: string; execution_id: string;
    version_number: number; file_name: string; size_bytes: number; sha256: string;
    document_status: "draft"; revision_note: string; object_name: string; ready_at: string | null;
  }>([
    [activeVersionId, {
      version_id: activeVersionId, deliverable_id: "item-1", owner_id: "owner-1", job_id: "job-1", execution_id: "exec-1",
      version_number: 1, file_name: "cases_v1.csv", size_bytes: Buffer.byteLength(csvV1), sha256: sha(csvV1),
      document_status: "draft", revision_note: "", object_name: "owner-1/job-1/exec-1/item-1", ready_at: "2026-11-27T01:00:00Z",
    }],
  ]);
  const storedObjects = new Map<string, Uint8Array>([
    ["owner-1/job-1/exec-1/item-1", Buffer.from(csvV1)],
  ]);

  const fakeClient = {
    rpc: (name: string, args: Record<string, unknown>) => {
      const run = async () => {
        if (name === "qa_artifact_revision_item") {
          return {
            data: {
              owner_id: "owner-1", job_id: "job-1", execution_id: "exec-1", deliverable_id: "item-1",
              kind: "test_case", file_name: "cases_v1.csv", size_bytes: Buffer.byteLength(csvV1),
              sha256: sha(csvV1), ready_at: "2026-11-27T01:00:00Z",
              active_version_id: activeVersionId, active_version_number: activeVersionNumber, document_status: "draft",
            },
            error: null,
          };
        }
        if (name === "qa_reserve_artifact_revision") {
          const match = [...versions.values()].find(v =>
            v.sha256 === args.p_sha && v.file_name === args.p_name && v.size_bytes === args.p_size && v.ready_at !== null);
          if (match) {
            return { data: { version: match, replay: true, alreadyReady: true, activeVersionId, activeVersionNumber }, error: null };
          }
          if (args.p_expected_active_version !== null && args.p_expected_active_version !== activeVersionNumber) {
            return { data: null, error: { code: "PT409", message: "ARTIFACT_VERSION_CONFLICT" } };
          }
          const nextNum = versions.size + 1;
          const verId = `22222222-2222-4222-8222-22222222222${nextNum}`;
          const row = {
            version_id: verId, deliverable_id: "item-1", owner_id: "owner-1", job_id: "job-1", execution_id: "exec-1",
            version_number: nextNum, file_name: String(args.p_name), size_bytes: Number(args.p_size), sha256: String(args.p_sha),
            document_status: "draft" as const, revision_note: String(args.p_revision_note ?? ""),
            object_name: `owner-1/job-1/exec-1/item-1/v/${verId}`, ready_at: null,
          };
          versions.set(verId, row);
          return { data: { version: row, replay: false, alreadyReady: false, activeVersionId, activeVersionNumber }, error: null };
        }
        if (name === "qa_finish_artifact_revision") {
          const row = versions.get(String(args.p_version_id));
          if (!row) return { data: null, error: { code: "PT409", message: "ARTIFACT_CONFLICT" } };
          if (!storedObjects.has(row.object_name)) return { data: null, error: { code: "PT503", message: "ARTIFACT_STORAGE_UNAVAILABLE" } };
          row.ready_at = "2026-11-27T02:00:00Z";
          activeVersionId = row.version_id;
          activeVersionNumber = row.version_number;
          return { data: { version: row, activated: true, activeVersionId, activeVersionNumber }, error: null };
        }
        throw new Error(`Unexpected RPC ${name}`);
      };
      if (name === "qa_artifact_revision_item") return { single: run };
      return run();
    },
    storage: {
      from: () => ({
        upload: async (path: string, bytes: Uint8Array) => {
          if (storageFail) return { error: { message: "simulated outage" } };
          storedObjects.set(path, bytes);
          return { error: null };
        },
        download: async (path: string) => {
          const data = storedObjects.get(path);
          return data ? { data: new Blob([new Uint8Array(data)]), error: null } : { data: null, error: { message: "missing" } };
        },
      }),
    },
  } as unknown as Parameters<typeof downloadArtifact>[0];

  const buildRequest = (fileName: string, content: string, opts?: { auth?: string; shaOverride?: string; status?: string; expected?: string }) => {
    const form = new FormData();
    form.set("file", new File([content], fileName, { type: "text/csv" }));
    form.set("sha256", opts?.shaOverride ?? sha(content));
    if (opts?.status) form.set("documentStatus", opts.status);
    if (opts?.expected) form.set("expectedActiveVersion", opts.expected);
    return new Request("https://app.example/api/v1/callbacks/qa/job-1/executions/exec-1/deliverables/item-1/revisions", {
      method: "POST",
      headers: opts?.auth === "" ? {} : { Authorization: `Bearer ${opts?.auth ?? token}` },
      body: form,
    });
  };

  // Unauthorized rejected
  await assert.rejects(
    uploadArtifactRevision(buildRequest("cases_v2.csv", csvV2, { auth: "" }), config, "job-1", "exec-1", "item-1", () => fakeClient, key),
    { code: "UNAUTHORIZED_CALLBACK" },
  );
  // XLSX rejected with 415 INVALID_ARTIFACT_FORMAT
  await assert.rejects(
    uploadArtifactRevision(buildRequest("cases_v2.xlsx", csvV2), config, "job-1", "exec-1", "item-1", () => fakeClient, key),
    { code: "INVALID_ARTIFACT_FORMAT" },
  );
  // Checksum mismatch rejected
  await assert.rejects(
    uploadArtifactRevision(buildRequest("cases_v2.csv", csvV2, { shaOverride: "0".repeat(64) }), config, "job-1", "exec-1", "item-1", () => fakeClient, key),
    { code: "CHECKSUM_MISMATCH" },
  );
  // Non-draft documentStatus rejected
  await assert.rejects(
    uploadArtifactRevision(buildRequest("cases_v2.csv", csvV2, { status: "final" }), config, "job-1", "exec-1", "item-1", () => fakeClient, key),
    { code: "INVALID_REQUEST" },
  );
  // Storage failure preserves active v1
  storageFail = true;
  await assert.rejects(
    uploadArtifactRevision(buildRequest("cases_fail.csv", "id,expected\n9,fail\n"), config, "job-1", "exec-1", "item-1", () => fakeClient, key),
    { code: "ARTIFACT_STORAGE_UNAVAILABLE" },
  );
  assert.equal(activeVersionNumber, 1);
  storageFail = false;

  // Successful revision upload activates v2 as draft
  const created = await uploadArtifactRevision(
    buildRequest("cases_v2.csv", csvV2, { expected: "1" }),
    config, "job-1", "exec-1", "item-1", () => fakeClient, key,
  );
  assert.equal(created.status, 201);
  assert.equal(created.payload.activated, true);
  assert.equal(created.payload.activeVersionNumber, 3); // version 2 was failed unready reservation; v3 is active
  assert.equal(created.payload.version.documentStatus, "draft");

  // Identical retry of active file does not duplicate
  const replayActive = await uploadArtifactRevision(
    buildRequest("cases_v2.csv", csvV2),
    config, "job-1", "exec-1", "item-1", () => fakeClient, key,
  );
  assert.equal(replayActive.status, 200);
  assert.equal(replayActive.payload.replay, true);
  assert.equal(replayActive.payload.activated, false);
  assert.equal(replayActive.payload.activeVersionNumber, activeVersionNumber);

  // Identical retry of superseded v1 does NOT duplicate and does NOT reactivate v1
  const replayOld = await uploadArtifactRevision(
    buildRequest("cases_v1.csv", csvV1),
    config, "job-1", "exec-1", "item-1", () => fakeClient, key,
  );
  assert.equal(replayOld.status, 200);
  assert.equal(replayOld.payload.replay, true);
  assert.equal(replayOld.payload.activated, false);
  assert.equal(replayOld.payload.version.versionNumber, 1);
  assert.equal(replayOld.payload.version.isActive, false);
  assert.equal(replayOld.payload.activeVersionNumber, activeVersionNumber);

  // Stale expectedActiveVersion rejected with 409 ARTIFACT_VERSION_CONFLICT
  await assert.rejects(
    uploadArtifactRevision(buildRequest("cases_v3.csv", "id,expected\n1,new\n", { expected: "1" }), config, "job-1", "exec-1", "item-1", () => fakeClient, key),
    { code: "ARTIFACT_VERSION_CONFLICT" },
  );
});

test("owner can download both active revised version and historical v1 while other accounts are denied", async (t) => {
  const { createHash } = await import("node:crypto");
  const csvV1 = "id,expected\n1,Old\n";
  const csvV2 = "id,expected\n1,New\n2,More\n";
  const v1Id = "11111111-1111-4111-8111-111111111111";
  const v2Id = "22222222-2222-4222-8222-222222222222";
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");

  const makeClient = (ownerMatch: string) => ({
    from: (table: string) => {
      const filters: Record<string, string> = {};
      const q = {
        select: () => q,
        eq: (k: string, v: string) => { filters[k] = v; return q; },
        not: () => q,
        order: () => {
          if (table === "qa_artifacts") {
            return Promise.resolve({
              data: [
                {
                  owner_id: "owner", job_id: "job", execution_id: "exec", deliverable_id: "tc", kind: "test_case",
                  file_name: "cases_v2.csv", size_bytes: Buffer.byteLength(csvV2), sha256: sha(csvV2),
                  ready_at: "2026-11-27T02:00:00Z", active_version_id: v2Id, active_version_number: 2, document_status: "draft",
                },
                {
                  owner_id: "owner", job_id: "job", execution_id: "exec", deliverable_id: "bug", kind: "bug_report",
                  file_name: "bugs.md", size_bytes: 12, sha256: sha("# Bug report"),
                  ready_at: "2026-11-27T01:00:00Z", active_version_id: "33333333-3333-4333-8333-333333333333",
                  active_version_number: 1, document_status: "draft",
                },
              ],
              error: null,
            });
          }
          return Promise.resolve({
            data: [
              {
                version_id: v2Id, deliverable_id: "tc", owner_id: "owner", job_id: "job", execution_id: "exec",
                version_number: 2, file_name: "cases_v2.csv", size_bytes: Buffer.byteLength(csvV2), sha256: sha(csvV2),
                document_status: "draft", revision_note: "Expanded cases", object_name: `owner/job/exec/tc/v/${v2Id}`,
                ready_at: "2026-11-27T02:00:00Z",
              },
              {
                version_id: v1Id, deliverable_id: "tc", owner_id: "owner", job_id: "job", execution_id: "exec",
                version_number: 1, file_name: "cases_v1.csv", size_bytes: Buffer.byteLength(csvV1), sha256: sha(csvV1),
                document_status: "draft", revision_note: "", object_name: "owner/job/exec/tc",
                ready_at: "2026-11-27T01:00:00Z",
              },
            ],
            error: null,
          });
        },
        maybeSingle: async () => {
          if (filters.owner_id !== ownerMatch) return { data: null, error: null };
          if (table === "qa_artifact_versions") {
            return {
              data: filters.version_id === v1Id ? {
                version_id: v1Id, deliverable_id: "tc", owner_id: "owner", job_id: "job", execution_id: "exec",
                version_number: 1, file_name: "cases_v1.csv", size_bytes: Buffer.byteLength(csvV1), sha256: sha(csvV1),
                document_status: "draft", revision_note: "", object_name: "owner/job/exec/tc",
                ready_at: "2026-11-27T01:00:00Z",
              } : null,
              error: null,
            };
          }
          return {
            data: {
              owner_id: "owner", job_id: "job", execution_id: "exec", deliverable_id: "tc", kind: "test_case",
              file_name: "cases_v2.csv", size_bytes: Buffer.byteLength(csvV2), sha256: sha(csvV2),
              ready_at: "2026-11-27T02:00:00Z", active_version_id: v2Id, active_version_number: 2, document_status: "draft",
            },
            error: null,
          };
        },
      };
      return q;
    },
    auth: { getSession: async () => ({ data: { session: { user: { id: "owner" }, access_token: "synthetic-token" } }, error: null }) },
  }) as unknown as Parameters<typeof downloadArtifact>[0];

  const client = makeClient("owner");
  const progress = await deliverableProgress(client, {
    jobId: "job", executionId: "exec", executionStatus: "succeeded",
  } as Parameters<typeof deliverableProgress>[1]);
  assert.equal(progress.items[0].activeVersionNumber, 2);
  assert.equal(progress.items[0].versionCount, 2);
  assert.equal(progress.items[0].documentStatus, "draft");
  assert.equal(progress.items[0].versions?.[0].isActive, true);
  assert.equal(progress.items[0].versions?.[1].versionNumber, 1);
  assert.equal(progress.items[0].versions?.[1].isActive, false);
  // Bug report remains untouched at v1
  assert.equal(progress.items[1].kind, "bug_report");
  assert.equal(progress.items[1].activeVersionNumber, 1);

  const config = { supabaseUrl: "https://storage.example", publishableKey: "test-key", origin: "https://app.example" };
  const fetchMock = t.mock.method(globalThis, "fetch", async (url: URL) => {
    if (url.pathname.endsWith(`/v/${v2Id}`)) return new Response(csvV2);
    if (url.pathname.endsWith("/owner/job/exec/tc")) return new Response(csvV1);
    return new Response("not found", { status: 404 });
  });

  // Cross-account denied on historical download without hitting Storage
  await assert.rejects(downloadArtifact(client, config, "other", "job", "tc", v1Id), { code: "ARTIFACT_NOT_FOUND" });
  assert.equal(fetchMock.mock.callCount(), 0);

  // Active download returns v2
  const activeRes = await downloadArtifact(client, config, "owner", "job", "tc");
  assert.equal(activeRes.headers.get("content-disposition"), 'attachment; filename="cases_v2.csv"');
  assert.equal(await activeRes.text(), csvV2);

  // Historical download returns v1
  const oldRes = await downloadArtifact(client, config, "owner", "job", "tc", v1Id);
  assert.equal(oldRes.headers.get("content-disposition"), 'attachment; filename="cases_v1.csv"');
  assert.equal(await oldRes.text(), csvV1);
});
