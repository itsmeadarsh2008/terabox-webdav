// TeraBox → WebDAV proxy. Zero dependencies (node:http only).
// Routes: /{label}/ collections (one per configured share),
// /{label}/{file} playable files. GET redirects to the gateway short link
// by default (zero bandwidth) or pipes bytes with Range in pipe mode.

import http from "node:http";
import { config } from "./config.js";
import { listShare, directLink, shareByLabel } from "./upstream.js";

const esc = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

const CONTENT_TYPES = {
  ".flac": "audio/flac", ".mp3": "audio/mpeg", ".m4a": "audio/mp4",
  ".ogg": "audio/ogg", ".oga": "audio/ogg", ".opus": "audio/ogg",
  ".wav": "audio/wav", ".aiff": "audio/aiff", ".alac": "audio/mp4",
  ".wma": "audio/x-ms-wma", ".mp4": "video/mp4", ".mkv": "video/x-matroska",
  ".m3u8": "application/x-mpegURL",
};

export function contentType(name) {
  const dot = name.lastIndexOf(".");
  return CONTENT_TYPES[(dot >= 0 ? name.slice(dot) : "").toLowerCase()] ?? "application/octet-stream";
}

function authed(req) {
  if (!config.DAV_USER) return true; // open local dev (warns at startup)
  const h = req.headers.authorization ?? "";
  if (!h.startsWith("Basic ")) return false;
  const [u, ...rest] = Buffer.from(h.slice(6), "base64").toString("utf8").split(":");
  return u === config.DAV_USER && rest.join(":") === config.DAV_PASS;
}

function deny(res) {
  res.writeHead(401, { "WWW-Authenticate": 'Basic realm="terabox-webdav"', "Content-Type": "text/plain" });
  res.end("auth required");
}

function response(href, name, { collection = false, size, type } = {}) {
  const props = collection
    ? `<D:resourcetype><D:collection/></D:resourcetype><D:displayname>${esc(name)}</D:displayname>`
    : `<D:resourcetype/><D:displayname>${esc(name)}</D:displayname>`
      + `<D:getcontentlength>${size ?? 0}</D:getcontentlength>`
      + `<D:getcontenttype>${esc(type ?? contentType(name))}</D:getcontenttype>`;
  return `<D:response><D:href>${esc(href)}</D:href>`
    + `<D:propstat><D:prop>${props}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
}

function multistatus(items) {
  return `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${items.join("")}</D:multistatus>`;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/xml; charset=utf-8", ...headers });
  res.end(body);
}

// Split path into [label, rest...], decoded.
function splitPath(url) {
  const pathname = new URL(url ?? "/", "http://x").pathname;
  return pathname.split("/").filter(Boolean).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
}

async function handlePropfind(req, res) {
  const depth = req.headers.depth ?? "1";
  const parts = splitPath(req.url);
  if (!parts.length) {
    const items = config.SHARES.map((s) => response(`/${encodeURIComponent(s.label)}/`, s.label, { collection: true }));
    return send(res, 207, multistatus(items));
  }
  const share = shareByLabel(parts[0]);
  if (!share) return send(res, 404, multistatus([]));
  let files;
  try {
    files = await listShare(share.url);
  } catch (err) {
    console.error("upstream list failed:", err.message);
    return send(res, 502, multistatus([]));
  }
  if (parts.length === 1) {
    const items = [response(`/${encodeURIComponent(share.label)}/`, share.label, { collection: true })];
    if (depth !== "0") {
      for (const f of files) {
        items.push(response(`/${encodeURIComponent(share.label)}/${encodeURIComponent(f.name)}`, f.name, { size: f.size }));
      }
    }
    return send(res, 207, multistatus(items));
  }
  const name = parts.slice(1).join("/");
  const hit = files.find((f) => f.name === name);
  if (!hit) return send(res, 404, multistatus([]));
  return send(res, 207, multistatus([
    response(`/${encodeURIComponent(share.label)}/${encodeURIComponent(hit.name)}`, hit.name, { size: hit.size }),
  ]));
}

async function handleGet(req, res, headOnly) {
  const parts = splitPath(req.url);
  if (parts.length < 2) return send(res, 404, multistatus([]));
  const share = shareByLabel(parts[0]);
  if (!share) return send(res, 404, multistatus([]));
  const name = parts.slice(1).join("/");
  let files;
  try {
    files = await listShare(share.url);
  } catch (err) {
    console.error("upstream list failed:", err.message);
    res.writeHead(502, { "Content-Type": "text/plain" });
    return res.end("upstream unavailable");
  }
  const hit = files.find((f) => f.name === name);
  if (!hit?.link) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("not found");
  }
  if (headOnly) {
    res.writeHead(200, {
      "Content-Type": contentType(hit.name),
      "Accept-Ranges": "bytes",
      ...(typeof hit.size === "number" ? { "Content-Length": hit.size } : {}),
    });
    return res.end();
  }
  if (config.PROXY_MODE !== "pipe") {
    // Zero-bandwidth: hand the client the gateway short link (it redirects).
    res.writeHead(302, { Location: hit.link });
    return res.end();
  }
  // Pipe mode: resolve fresh dlink, forward Range, stream bytes through us.
  const target = await directLink(share.url, name).catch(() => null) ?? hit.link;
  const range = req.headers.range;
  try {
    const up = await fetch(target, {
      headers: range ? { Range: range } : {},
      signal: AbortSignal.timeout(30000),
      redirect: "follow",
    });
    if (!up.ok && up.status !== 206) throw new Error(`upstream ${up.status}`);
    const headers = { "Content-Type": contentType(hit.name), "Accept-Ranges": "bytes" };
    for (const h of ["content-range", "content-length"]) {
      const v = up.headers.get(h);
      if (v) headers[h === "content-range" ? "Content-Range" : "Content-Length"] = v;
    }
    res.writeHead(up.status, headers);
    if (up.body) {
      for await (const chunk of up.body) {
        if (!res.write(chunk)) await new Promise((r) => res.once("drain", r));
      }
    }
    res.end();
  } catch (err) {
    console.error("pipe failed:", err.message);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("upstream unavailable");
    } else {
      res.destroy();
    }
  }
}

export function createServer() {
  return http.createServer((req, res) => {
    if (!authed(req, res)) return deny(res);
    const method = (req.method ?? "GET").toUpperCase();
    if (method === "OPTIONS") {
      res.writeHead(200, {
        DAV: "1, 2",
        Allow: "OPTIONS, PROPFIND, GET, HEAD",
        "Content-Length": "0",
      });
      return res.end();
    }
    if (method === "PROPFIND") return handlePropfind(req, res).catch((err) => {
      console.error("propfind failed:", err.message);
      send(res, 500, multistatus([]));
    });
    if (method === "HEAD") return handleGet(req, res, true).catch((err) => {
      console.error("head failed:", err.message);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("error");
      }
    });
    if (method === "GET") return handleGet(req, res, false).catch((err) => {
      console.error("get failed:", err.message);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("error");
      }
    });
    res.writeHead(501, { "Content-Type": "text/plain" });
    res.end("read-only DAV (OPTIONS, PROPFIND, GET, HEAD)");
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!config.DAV_USER) console.error("warning: no DAV_USER set — open access (local dev only)");
  if (!config.SHARES.length) console.error("warning: TERABOX_SHARES empty — root will list nothing");
  createServer().listen(config.PORT, () => {
    console.log(`terabox-webdav on :${config.PORT} (mode=${config.PROXY_MODE}, shares=${config.SHARES.length})`);
  });
}
