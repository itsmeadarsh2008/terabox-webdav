import fs from "node:fs";
import path from "node:path";

// Minimal .env loader (no dependency): KEY=value lines, # comments.
try {
  const envFile = path.resolve(".env");
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m || process.env[m[1]] !== undefined) continue;
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
} catch {
  // .env is optional; environment wins.
}

// "Label|https://..." entries, comma-separated. Label becomes the top-level
// collection; bare URLs get an indexed fallback name.
function parseShares() {
  const raw = (process.env.TERABOX_SHARES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return raw.map((entry, i) => {
    const bar = entry.indexOf("|");
    if (bar > 0) return { label: entry.slice(0, bar).trim() || `share-${i + 1}`, url: entry.slice(bar + 1).trim() };
    return { label: `share-${i + 1}`, url: entry };
  }).filter((s) => s.url);
}

export const config = {
  PORT: Number(process.env.PORT ?? 8086),
  DAV_USER: process.env.DAV_USER ?? "",
  DAV_PASS: process.env.DAV_PASS ?? "",
  GATEWAY_URL: (process.env.TERABOX_GATEWAY_URL ?? "http://localhost:5000").replace(/\/$/, ""),
  SHARES: parseShares(),
  PROXY_MODE: (process.env.PROXY_MODE ?? "redirect") === "pipe" ? "pipe" : "redirect",
};
