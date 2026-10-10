import { config } from "./config.js";

// Thin client over saahiyo/terabox-gateway. Auth (ndus cookie) lives in the
// gateway; we only pass share URLs and read back file lists + links.
async function gw(params) {
  const url = new URL(`${config.GATEWAY_URL}/api`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error(`gateway ${res.status}`);
  return res.json();
}

// List audio+video files in one share. Returns [{ name, size, link }]
// where link is the gateway short proxy link (cookie-less, redirecting).
export async function listShare(shareUrl) {
  const data = await gw({ url: shareUrl });
  if (data?.status && data.status !== "success") {
    throw new Error(`resolve failed: ${data.message ?? data.status}`);
  }
  const files = data?.files ?? [];
  return (Array.isArray(files) ? files : []).map((f) => ({
    name: String(f.filename ?? f.name ?? f.path ?? "").split(/[\\/]/).pop(),
    size: typeof f.size === "number" ? f.size : undefined,
    link: f.download_link ?? f.downloadLink ?? f.link ?? f.url ?? null,
  })).filter((f) => f.name && f.link);
}

// Fresh fully-resolved direct link for one file (dlinks expire).
export async function directLink(shareUrl, filename) {
  const data = await gw({ url: shareUrl, resolve: "true" });
  const files = data?.files ?? [];
  const hit = (Array.isArray(files) ? files : []).find((f) => {
    const n = String(f.filename ?? f.name ?? f.path ?? "").split(/[\\/]/).pop();
    return n === filename;
  });
  return hit ? (hit.download_link ?? hit.downloadLink ?? hit.link ?? hit.url ?? null) : null;
}

export function shareByLabel(label) {
  return config.SHARES.find((s) => s.label === label) ?? null;
}
