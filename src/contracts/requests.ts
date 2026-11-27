import { z } from "zod";

export const deliverableCatalog = {
  test_plan: { label: "Test Plan", extension: "md" },
  test_case: { label: "Test Case", extension: "csv" },
  api_report: { label: "API Report", extension: "md" },
  automation_script: { label: "Automation Script", extension: "zip" },
  security_report: { label: "Security Report", extension: "md" },
  performance_report: { label: "Performance Report", extension: "md" },
  bug_report: { label: "Bug Report", extension: "md" },
} as const;

export const deliverableKind = z.enum(Object.keys(deliverableCatalog) as (keyof typeof deliverableCatalog)[]);
export type DeliverableKind = z.infer<typeof deliverableKind>;

function validHttpUrl(value: string, allowFragment: boolean): boolean {
  try {
    const url = new URL(value);
    if (!/^https?:\/\/[^/@?#\s\\]+/u.test(value) || /[\u0000-\u001f\u007f\s\\]/u.test(value)) return false;
    if (url.username || url.password) return false;
    if (value.slice(value.indexOf("//") + 2).split(/[/?#]/u)[0].includes("@")) return false;
    const hashIndex = value.indexOf("#");
    if (!allowFragment) return hashIndex === -1 && !url.hash;
    return hashIndex === -1 || (url.hash.length > 1 && !value.slice(hashIndex + 1).includes("#"));
  } catch {
    return false;
  }
}

export const requestUrl = z.string().max(2048).refine(value => validHttpUrl(value, false));
export const scopeUrl = z.string().max(2048).refine(value => validHttpUrl(value, true));

const accessNotes = z.string().max(1000).refine(value =>
  !/(?:\b(?:password|passwd|kata sandi|token|api[_ -]?key|secret|otp)\s*[:=]|\bbearer\s+[\w.-]+|https?:\/\/[^\s/?#]*@|-----BEGIN [^-]*PRIVATE KEY-----)/iu.test(value),
);
const fields = {
  accessRequiresLogin: z.boolean(),
  accessNotes,
  targetUrl: z.string().max(2048),
  environment: z.enum(["development", "staging", "production", "other"]),
  scopeUrls: z.array(z.string().max(2048)).max(12),
  acceptanceCriteria: z.array(z.string().max(500)).max(10),
  suggestions: z.string().max(2000),
  prohibitions: z.string().max(2000),
  deliverables: z.array(deliverableKind).max(7),
};
export const draftDataSchema = z.strictObject(fields).partial();
export const revisionSchema = z.number().int().min(1).max(2147483646);
export const submissionSchema = z.strictObject({
  ...fields,
  targetUrl: requestUrl,
  scopeUrls: z.array(scopeUrl).min(1).max(12).refine(urls => new Set(urls.map(url => new URL(url).href)).size === urls.length),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(500)).min(1).max(10),
  accessRequiresLogin: fields.accessRequiresLogin.default(false),
  accessNotes: fields.accessNotes.default(""),
  suggestions: fields.suggestions.default(""),
  prohibitions: fields.prohibitions.default(""),
  deliverables: fields.deliverables.min(1).refine(items => new Set(items).size === items.length),
});

export type DraftData = z.infer<typeof draftDataSchema>;
export type ValidatedSubmission = z.infer<typeof submissionSchema>;
type OptionalAccessFields = "accessRequiresLogin" | "accessNotes";
export type Submission = Omit<ValidatedSubmission, OptionalAccessFields> &
  Partial<Pick<ValidatedSubmission, OptionalAccessFields>>;
export type Draft = {
  draftId: string;
  data: DraftData;
  revision: number;
  jobId: string | null;
  updatedAt: string;
};
export type Deliverable = {
  deliverableId: string;
  kind: DeliverableKind;
  status: "pending" | "ready" | "failed";
  fileName: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  readyAt: string | null;
  downloadUrl: string | null;
};
export const ARTIFACT_MAX_BYTES = 3 * 1024 * 1024;
