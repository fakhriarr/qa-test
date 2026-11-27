import { test } from "node:test";
import assert from "node:assert/strict";
import { ARTIFACT_MAX_BYTES, deliverableCatalog, draftDataSchema, submissionSchema } from "../src/contracts/requests";
import { validArtifact } from "../src/server/artifact-format";
import { visibleLinkCandidates } from "../src/server/discovery";
import { artifactPath, artifactToken, downloadArtifact, storageCapability } from "../src/server/artifacts";

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

test("discovery returns same-origin anchor candidates without navigation", () => {
  const html = `<!doctype html><html><head><title>shop</title></head><body>
    <a href="/cart">Keranjang</a><a href="/cart#total">Total</a>
    <a href="https://elsewhere.example/checkout">External</a>
    <div hidden><a href="/hidden">Hidden</a></div>
    <script>const sample = '<a href="/script">Ignored</a>';</script>
    <!-- <a href="/comment">Ignored</a> -->
    <a download href="/export.csv">Download</a><a href="/help?a=1&amp;b=2">Bantuan</a>
    </body></html>`;
  assert.deepEqual(visibleLinkCandidates(html, new URL("https://shop.example/")), [
    "https://shop.example/cart", "https://shop.example/help?a=1&b=2",
  ]);
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
