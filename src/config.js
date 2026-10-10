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

export const config = {
  PORT: Number(process.env.PORT ?? 8086),
  DAV_USER: process.env.DAV_USER ?? "",
  DAV_PASS: process.env.DAV_PASS ?? "",
  // rclone storage backend (TeraBox remote). RCLONE_CONFIG points at a file
  // holding the terabox remote (ndus cookie); RCLONE_REMOTE names it.
  RCLONE_BIN: process.env.RCLONE_BIN ?? "rclone",
  RCLONE_CONFIG: process.env.RCLONE_CONFIG ?? "",
  RCLONE_REMOTE: process.env.RCLONE_REMOTE ?? "terabox:",
  RCLONE_TIMEOUT_MS: Number(process.env.RCLONE_TIMEOUT_MS ?? 60000),
  // Remote root exposed as WebDAV `/`.
  BASE_PATH: (process.env.RCLONE_BASE_PATH ?? "/").replace(/\/+$/, "") || "/",
  // JSON file persisting locks + dead props across restarts (empty = memory).
  PROP_STORE: process.env.PROP_STORE ?? "",
  // Cap granted lock lifetimes (seconds).
  LOCK_TIMEOUT_MAX: Number(process.env.LOCK_TIMEOUT_MAX ?? 86400),
};
