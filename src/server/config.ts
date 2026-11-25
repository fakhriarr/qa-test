import "./only";
import { Fault } from "./errors";
export type AppConfig = { supabaseUrl: string; publishableKey: string; origin: string };
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
