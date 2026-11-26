import "./only";
import { hkdfSync } from "node:crypto";
import { Fault } from "./errors";
export type AppConfig = { supabaseUrl: string; publishableKey: string; origin: string };
export type WebhookConfig = { webhookUrl: string; webhookSecret: string; callbackKeyMaterial: Uint8Array };
export function readConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const fail = () => new Fault(503, "SETUP_REQUIRED", "Konfigurasi Supabase dan origin aplikasi belum siap. Hubungi operator.");
  const { NEXT_PUBLIC_SUPABASE_URL: rawUrl, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: key, QA_APP_ORIGIN: rawOrigin } = env;
  if (!rawUrl || !key || !rawOrigin) throw fail();
  try {
    const url = new URL(rawUrl), origin = new URL(rawOrigin);
    if (url.protocol !== "https:" || url.pathname !== "/" || url.username || url.password || url.search || url.hash || url.hostname === "supabase.com") throw fail();
    if (origin.protocol !== "https:" || origin.origin !== rawOrigin || origin.username || origin.password || origin.search || origin.hash) throw fail();
    // Only the current publishable key format is accepted; no secret/admin JWT key in runtime.
    if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) throw fail();
    return { supabaseUrl: url.origin, publishableKey: key, origin: origin.origin };
  } catch { throw fail(); }
}
export function readWebhookConfig(env: Record<string, string | undefined> = process.env): WebhookConfig {
  const fail = () => new Fault(503, "WEBHOOK_UNCONFIGURED", "Konfigurasi webhook QA belum siap di server. Hubungi operator.");
  const { QA_WEBHOOK_URL: rawWebhookUrl, QA_WEBHOOK_SECRET: webhookSecret, QA_CALLBACK_SECRET: callbackSecret } = env;
  if (!rawWebhookUrl || /\s/.test(rawWebhookUrl) || !webhookSecret || !webhookSecret.trim()) throw fail();
  let parsed: URL;
  try { parsed = new URL(rawWebhookUrl); }
  catch { throw fail(); }
  if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) throw fail();
  const callbackKeyMaterial = callbackSecret && callbackSecret.trim().length > 0
    ? new Uint8Array(Buffer.from(callbackSecret, "utf8"))
    : new Uint8Array(hkdfSync(
        "sha256",
        Buffer.from(webhookSecret, "utf8"),
        "qa-dashboard:callback-subkey-salt:v1",
        "qa-dashboard:callback-key-material:v1",
        32,
      ));
  return { webhookUrl: parsed.toString(), webhookSecret, callbackKeyMaterial };
}
