import "./only";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { scopeUrl } from "../contracts/requests";
import { assert, Fault } from "./errors";

const nonPublic = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 3],
] as const) nonPublic.addSubnet(address, prefix, "ipv4");

const BODY_LIMIT = 256 * 1024;
const TIMEOUT_MS = 4000;
const allowedHost = (url: URL) => url.protocol === "https:" && !url.port && !url.username && !url.password &&
  !isIP(url.hostname) && /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(url.hostname) &&
  !/\.(?:local|localhost|internal|test|invalid|example|onion|home|lan)$/i.test(url.hostname);

function unavailable() {
  return new Fault(422, "DISCOVERY_UNAVAILABLE", "Halaman HTML publik tidak dapat dibaca. Tambahkan URL manual.");
}

async function resolvePublicIPv4(hostname: string, signal: AbortSignal) {
  const addresses = await new Promise<Awaited<ReturnType<typeof resolveAll>>>((resolve, reject) => {
    const abort = () => reject(unavailable());
    signal.addEventListener("abort", abort, { once: true });
    resolveAll(hostname).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  }).catch(() => { throw unavailable(); });
  assert(addresses.length && addresses.every(({ address, family }) =>
    family === 4 && !nonPublic.check(address, "ipv4")), 422, "DISCOVERY_TARGET_DENIED",
  "Pemindaian hanya mendukung host HTTPS publik melalui IPv4.");
  return addresses[0].address;
}

function resolveAll(hostname: string) {
  return lookup(hostname, { family: 4, all: true });
}

async function fetchHtml(url: URL, address: string, signal: AbortSignal) {
  return new Promise<string>((resolve, reject) => {
    const req = httpsRequest(url, {
      method: "GET", signal, agent: false, family: 4,
      // Connect only to the validated address. Preserve the original TLS name and Host.
      lookup: (_hostname, _options, callback) => callback(null, address, 4),
      headers: { accept: "text/html", "accept-encoding": "identity", "user-agent": "QA-Dashboard-Link-Discovery/1.0" },
    }, response => {
      const type = response.headers["content-type"] ?? "";
      const encoding = response.headers["content-encoding"];
      if (response.statusCode !== 200 || !/^text\/html\s*(?:;|$)/i.test(type) ||
          (encoding && encoding !== "identity") || Number(response.headers["content-length"]) > BODY_LIMIT) {
        response.destroy();
        reject(unavailable());
        return;
      }
      const chunks: Buffer[] = [];
      let length = 0;
      response.on("error", () => reject(unavailable()));
      response.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > BODY_LIMIT) {
          response.destroy();
          reject(unavailable());
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        try { resolve(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, length))); }
        catch { reject(unavailable()); }
      });
    });
    req.on("error", () => reject(unavailable()));
    req.end();
  });
}

const voidTags = new Set("area base br col embed hr img input link meta param source track wbr".split(" "));
const ignored = new Set("head script style template noscript textarea title xmp iframe noembed noframes svg math select object dialog details".split(" "));
const rawText = new Set("script style textarea title xmp iframe noembed noframes".split(" "));

export function visibleLinkCandidates(html: string, page: URL): string[] {
  const base = new URL(page.href);
  base.hash = "";
  const tokens = /<!--[\s\S]*?(?:-->|$)|<![^>]*>|<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)(?=[\s/>])((?:"[^"]*"|'[^']*'|[^'"<>])*)>/g;
  const ancestors: { tag: string; hidden: boolean }[] = [];
  const urls = new Set<string>();
  for (const match of html.matchAll(tokens)) {
    if (!match[2]) continue;
    const tag = match[2].toLowerCase();
    const parent = ancestors.at(-1);
    if (parent && rawText.has(parent.tag) && !(match[1] && tag === parent.tag)) continue;
    if (match[1]) {
      let index = ancestors.length - 1;
      while (index >= 0 && ancestors[index].tag !== tag) index--;
      if (index >= 0) ancestors.length = index;
      continue;
    }
    const attrs = new Map<string, string>();
    for (const attr of match[3].matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
      const key = attr[1].toLowerCase();
      if (!attrs.has(key)) attrs.set(key, attr[2] ?? attr[3] ?? attr[4] ?? "");
    }
    if (tag === "base" && attrs.has("href")) return [];
    const hidden = Boolean(parent?.hidden || ignored.has(tag) || attrs.has("hidden") || attrs.has("inert") ||
      attrs.get("aria-hidden")?.toLowerCase() === "true" ||
      /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(attrs.get("style") ?? ""));
    if (!voidTags.has(tag)) ancestors.push({ tag, hidden });
    // Skip constructs that depend on markup or navigation state we do not emulate.
    const raw = attrs.get("href")?.trim();
    if (hidden || tag !== "a" || !raw || attrs.has("download")) continue;
    try {
      const url = new URL(raw.replace(/&amp;/gi, "&"), base);
      if (!url.hash) url.hash = "";
      if (url.origin === base.origin && url.href !== base.href && scopeUrl.safeParse(url.href).success) urls.add(url.href);
    } catch { continue; }
    if (urls.size === 40) break;
  }
  return [...urls];
}

export async function discoverLinks(target: string): Promise<string[]> {
  assert(!target.includes("#"), 422, "DISCOVERY_TARGET_DENIED", "Gunakan URL publik tanpa fragmen.");
  const url = new URL(target);
  assert(allowedHost(url), 422, "DISCOVERY_TARGET_DENIED", "Gunakan host HTTPS publik pada port standar.");
  // Never forward tokens in a supplied query and never follow redirects or discovered links.
  assert(!url.search && !url.hash && url.pathname.startsWith("/") && !url.pathname.startsWith("//"),
    422, "DISCOVERY_TARGET_DENIED", "Gunakan URL publik tanpa parameter query.");
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const address = await resolvePublicIPv4(url.hostname, signal);
  const html = await fetchHtml(url, address, signal);
  return visibleLinkCandidates(html, url);
}
