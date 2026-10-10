// TeraBox → WebDAV, full RFC 4918 support. Zero dependencies (node:http only).
// Storage backend is an rclone remote (TeraBox): every method translates to
// rclone CLI ops, so this box holds no bytes. Locks + dead props live here.

import http from "node:http";
import path from "node:path";
import { config } from "./config.js";
import { createRclone } from "./rclone.js";
import { createStore, checkIf, parseIf } from "./store.js";

const rc = () => createRclone({
  bin: config.RCLONE_BIN,
  config: config.RCLONE_CONFIG,
  remote: config.RCLONE_REMOTE,
  timeoutMs: config.RCLONE_TIMEOUT_MS,
});
const store = createStore(config.PROP_STORE);

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
  if (!config.DAV_USER) return true;
  const h = req.headers.authorization ?? "";
  if (!h.startsWith("Basic ")) return false;
  const [u, ...rest] = Buffer.from(h.slice(6), "base64").toString("utf8").split(":");
  return u === config.DAV_USER && rest.join(":") === config.DAV_PASS;
}

function deny(res) {
  res.writeHead(401, { "WWW-Authenticate": 'Basic realm="terabox-webdav"', "Content-Type": "text/plain" });
  res.end("auth required");
}

// URL path -> { urlPath (normalized, decoded), remote (rclone path) }.
// Returns null on escape attempts (null byte, .. above root).
function mapPath(rawUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(rawUrl ?? "/", "http://x").pathname);
  } catch {
    return null;
  }
  if (pathname.includes("\0")) return null;
  const norm = path.posix.normalize("/" + pathname);
  const rel = norm.replace(/^\/+/, "");
  const remote = (config.BASE_PATH + "/" + rel).replace(/\/+/g, "/").replace(/\/$/, "") || "/";
  return { urlPath: norm, remote };
}

function hrefOf(urlPath) {
  return urlPath.split("/").map((s) => encodeURIComponent(s)).join("/") || "/";
}

function etagOf(entry) {
  return `"${entry?.size ?? 0}-${entry?.modTime ?? ""}"`;
}

function httpDate(modTime) {
  const t = modTime ? Date.parse(modTime) : NaN;
  return Number.isFinite(t) ? new Date(t).toUTCString() : null;
}

// ---- XML builders ---------------------------------------------------------

function propXml(tag, entry, urlPath, wanted) {
  // wanted: null (allprop) | "propname" | [clark names]
  const dead = store.getProps(urlPath);
  const lastmod = httpDate(entry?.modTime);
  const live = {
    "{DAV:}resourcetype": () => entry?.isDir
      ? `<D:resourcetype><D:collection/></D:resourcetype>` : `<D:resourcetype/>`,
    "{DAV:}displayname": () => `<D:displayname>${esc(urlPath.split("/").filter(Boolean).pop() ?? "")}</D:displayname>`,
    "{DAV:}getcontentlength": () => entry && !entry.isDir && typeof entry.size === "number"
      ? `<D:getcontentlength>${entry.size}</D:getcontentlength>` : null,
    "{DAV:}getcontenttype": () => entry && !entry.isDir
      ? `<D:getcontenttype>${esc(contentType(entry.name ?? ""))}</D:getcontenttype>` : null,
    "{DAV:}getlastmodified": () => lastmod ? `<D:getlastmodified>${lastmod}</D:getlastmodified>` : null,
    "{DAV:}creationdate": () => lastmod ? `<D:creationdate>${lastmod}</D:creationdate>` : null,
    "{DAV:}getetag": () => entry ? `<D:getetag>${esc(etagOf(entry))}</D:getetag>` : null,
    "{DAV:}supportedlock": () => `<D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry><D:lockentry><D:lockscope><D:shared/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock>`,
    "{DAV:}lockdiscovery": () => lockDiscoveryXml(urlPath),
  };
  const keys = wanted === null
    ? [...Object.keys(live), ...dead.keys()]
    : wanted === "propname"
      ? [...Object.keys(live), ...dead.keys()]
      : wanted;
  if (wanted === "propname") {
    const names = keys.map((k) => {
      const [ns, local] = splitClark(k);
      const pfx = ns === "DAV:" ? "D" : "Z";
      return `<${pfx}:${esc(local)} xmlns${pfx === "D" ? ":D" : ":Z"}="${esc(ns)}"/>`;
    }).join("");
    return `<D:response><D:href>${esc(hrefOf(urlPath))}</D:href>`
      + `<D:propstat><D:prop>${names}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
  }
  const found = [];
  const missing = [];
  for (const k of keys) {
    if (live[k]) {
      const v = live[k]();
      if (v != null) {
        found.push(v);
        continue;
      }
    }
    if (dead.has(k)) {
      const [ns, local] = splitClark(k);
      found.push(`<Z:${esc(local)} xmlns:Z="${esc(ns)}">${dead.get(k)}</Z:${esc(local)}>`);
      continue;
    }
    const [ns, local] = splitClark(k);
    missing.push(`<${ns === "DAV:" ? "D" : "Z"}:${esc(local)}/>`);
  }
  let out = `<D:response><D:href>${esc(hrefOf(urlPath))}</D:href>`;
  if (found.length) {
    out += `<D:propstat><D:prop>${found.join("")}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>`;
  }
  if (missing.length) {
    out += `<D:propstat><D:prop>${missing.join("")}</D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat>`;
  }
  return out + `</D:response>`;
}

// xmlns:PREFIX="ns" declarations in a request body (default ns → "").
function namespacesOf(body) {
  const map = {};
  const re = /xmlns(?::(\w+))?="([^"]*)"/g;
  let m;
  while ((m = re.exec(body))) map[m[1] ?? ""] = m[2];
  return map;
}

// Clark {ns}local for a possibly-prefixed tag using the body's declarations.
function clark(nsmap, defaultNs, tag) {
  const i = tag.indexOf(":");
  if (i < 0) return `{${defaultNs}}${tag}`;
  const ns = nsmap[tag.slice(0, i)] ?? defaultNs;
  return `{${ns}}${tag.slice(i + 1)}`;
}

function splitClark(key) {
  const m = key.match(/^\{([^}]*)\}(.*)$/);
  return m ? [m[1], m[2]] : ["DAV:", key];
}

function lockDiscoveryXml(urlPath) {
  const l = lockFor(urlPath);
  if (!l) return `<D:lockdiscovery/>`;
  return `<D:lockdiscovery><D:activelock><D:locktype><D:write/></D:locktype>`
    + `<D:lockscope><D:${l.scope}/></D:lockscope><D:depth>${esc(l.depth)}</D:depth>`
    + `<D:owner>${esc(l.owner)}</D:owner><D:timeout>Second-${Math.max(0, Math.round((l.expiresAt - Date.now()) / 1000))}</D:timeout>`
    + `<D:locktoken><D:href>${esc(l.token)}</D:href></D:locktoken></D:activelock></D:lockdiscovery>`;
}

// store.js keeps locks keyed by exact path; mirror them here for PROPFIND
// lockdiscovery (single process owns both).
function lockFor(urlPath) {
  return activeLocks.get(urlPath) ?? null;
}
const activeLocks = new Map();

function lockedXml(urlPath) {
  const l = lockFor(urlPath);
  const inner = l
    ? `<D:locktoken><D:href>${esc(l.token)}</D:href></D:locktoken>`
    : `<D:need-privileges/>`;
  return `<?xml version="1.0" encoding="utf-8"?><D:error xmlns:D="DAV:"><D:lock-token-submitted>${inner}</D:lock-token-submitted></D:error>`;
}

function sendXml(res, status, body, extra = {}) {
  res.writeHead(status, { "Content-Type": "application/xml; charset=utf-8", ...extra });
  res.end(body);
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on("data", (c) => {
      total += c.length;
      if (total > limit) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ---- handlers ---------------------------------------------------------------

async function entryAt(remotePath, name) {
  // Stat via parent listing (rclone has no single-stat for all backends).
  // Match top-level entries only: deeper same-named files must not shadow.
  const parent = remotePath.split("/").slice(0, -1).join("/") || "/";
  const items = await rc().list(parent);
  const hit = items.find((e) => e.name === name && !(e.path ?? "").includes("/"));
  if (!hit) {
    const err = new Error("not found");
    err.code = "ENOTFOUND";
    throw err;
  }
  return hit;
}

async function handlePropfind(req, res) {
  const mapped = mapPath(req.url);
  if (!mapped) return sendXml(res, 400, multistatus([]));
  const depth = (req.headers.depth ?? "1").trim();
  if (!["0", "1"].includes(depth)) {
    // Depth:infinity refused: unbounded walks over a network remote.
    return sendXml(res, 403, multistatus([]));
  }
  const body = await readBody(req).catch(() => "");
  const { wanted } = parsePropfind(body);
  const isRoot = mapped.urlPath === "/";
  let entry = null;
  if (!isRoot) {
    try {
      entry = await entryAt(mapped.remote, mapped.urlPath.split("/").filter(Boolean).pop());
    } catch (err) {
      if (err.code === "ENOTFOUND") return sendXml(res, 404, multistatus([]));
      return sendXml(res, 502, multistatus([]));
    }
    if (!entry.isDir && depth !== "0") {
      // Depth on a file behaves as Depth:0.
    }
  }
  const items = [propXml(null, isRoot ? { isDir: true } : entry, mapped.urlPath, wanted)];
  if (depth === "1" && (isRoot || entry?.isDir)) {
    let kids = [];
    try {
      const r = rc();
      const all = await r.list(mapped.remote === "/" ? "/" : mapped.remote);
      kids = isRoot ? all : all;
    } catch {
      return sendXml(res, 502, multistatus([]));
    }
    // list() on the dir itself returns its children (files-only, recursive —
    // filter to direct children for depth:1).
    const prefix = mapped.remote === "/" ? "/" : mapped.remote + "/";
    const seen = new Set();
    for (const k of kids) {
      const rel = ("/" + (k.path ?? k.name)).replace(/\/+/g, "/");
      const under = rel.startsWith(prefix) ? rel.slice(prefix.length) : null;
      if (under == null || !under) continue;
      const top = under.split("/")[0];
      if (seen.has(top)) continue;
      seen.add(top);
      const childUrl = (mapped.urlPath === "/" ? "" : mapped.urlPath) + "/" + top;
      if (under.includes("/")) {
        items.push(propXml(null, { isDir: true, name: top }, childUrl, wanted));
      } else {
        items.push(propXml(null, { ...k, name: top }, childUrl, wanted));
      }
    }
  }
  return sendXml(res, 207, multistatus(items));
}

function multistatus(items) {
  return `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${items.join("")}</D:multistatus>`;
}

// <allprop/> | <propname/> | <prop><tag/>...</prop>  (prefix-agnostic)
function parsePropfind(body) {
  if (!body || /<\w*:?allprop\s*\/?>/.test(body)) return { wanted: null };
  if (/<\w*:?propname\s*\/?>/.test(body)) return { wanted: "propname" };
  const m = body.match(/<\w*:?prop[^>]*>([\s\S]*?)<\/\w*:?prop>/);
  const names = [];
  if (m) {
    const nsmap = namespacesOf(body);
    const re = /<((?:\w+:)?[\w.-]+)(?:\s[^>]*)?\/?>/g;
    let t;
    while ((t = re.exec(m[1]))) {
      const full = t[1];
      if (full.toLowerCase() === "prop") continue;
      names.push(clark(nsmap, "DAV:", full));
    }
  }
  return { wanted: names };
}

async function handleGet(req, res, headOnly) {
  const mapped = mapPath(req.url);
  if (!mapped || mapped.urlPath === "/") {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("not found");
  }
  let entry;
  try {
    entry = await entryAt(mapped.remote, mapped.urlPath.split("/").filter(Boolean).pop());
  } catch (err) {
    res.writeHead(err.code === "ENOTFOUND" ? 404 : 502, { "Content-Type": "text/plain" });
    return res.end(err.code === "ENOTFOUND" ? "not found" : "upstream unavailable");
  }
  if (entry.isDir) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("not found");
  }
  const size = entry.size ?? 0;
  const headers = {
    "Content-Type": contentType(entry.name ?? ""),
    "Accept-Ranges": "bytes",
    ETag: etagOf(entry),
  };
  const range = req.headers.range;
  let start = 0;
  let end = size - 1;
  let partial = false;
  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    if (!m) {
      res.writeHead(416, { "Content-Type": "text/plain" });
      return res.end("bad range");
    }
    if (m[1] === "" && m[2] !== "") {
      const tail = Number(m[2]);
      start = Math.max(0, size - tail);
    } else {
      start = m[1] ? Number(m[1]) : 0;
      end = m[2] ? Number(m[2]) : size - 1;
    }
    if (start >= size || end < start) {
      res.writeHead(416, { "Content-Range": `bytes */${size}`, "Content-Type": "text/plain" });
      return res.end("range unsatisfiable");
    }
    end = Math.min(end, size - 1);
    partial = true;
  }
  const status = partial ? 206 : 200;
  const outHeaders = { ...headers };
  if (partial) {
    outHeaders["Content-Range"] = `bytes ${start}-${end}/${size}`;
    outHeaders["Content-Length"] = end - start + 1;
  } else if (size) {
    outHeaders["Content-Length"] = size;
  }
  res.writeHead(status, outHeaders);
  if (headOnly) return res.end();
  try {
    const { stream, done } = rc().catRange(mapped.remote, start, partial || size ? end : undefined);
    // Full-file fast path: stat-known size with no range → whole object.
    stream.on("error", () => res.destroy());
    done.catch(() => res.destroy());
    stream.pipe(res);
  } catch (err) {
    console.error("get failed:", err.message);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("upstream unavailable");
    } else res.destroy();
  }
}

async function precond(req, res, urlPath, remotePath) {
  // Current etag for If evaluation (missing resource → null etag).
  let etag = null;
  try {
    const e = await entryAt(remotePath, urlPath.split("/").filter(Boolean).pop());
    etag = etagOf(e);
  } catch { /* absent */ }
  const verdict = checkIf(store, urlPath, etag, req.headers.if);
  if (verdict === "locked") {
    res.writeHead(423, { "Content-Type": "application/xml; charset=utf-8" });
    res.end(lockedXml(urlPath));
    return false;
  }
  if (verdict === "precondition") {
    res.writeHead(412, { "Content-Type": "text/plain" });
    res.end("precondition failed");
    return false;
  }
  return true;
}

async function handlePut(req, res) {
  const mapped = mapPath(req.url);
  if (!mapped || mapped.urlPath === "/") {
    res.writeHead(403, { "Content-Type": "text/plain" });
    return res.end("cannot PUT a collection");
  }
  if (req.headers["if-none-match"] === "*") {
    try {
      await entryAt(mapped.remote, mapped.urlPath.split("/").filter(Boolean).pop());
      res.writeHead(412, { "Content-Type": "text/plain" });
      return res.end("exists");
    } catch { /* absent -> proceed */ }
  }
  if (!await precond(req, res, mapped.urlPath, mapped.remote)) return;
  const existed = await entryAt(mapped.remote, mapped.urlPath.split("/").filter(Boolean).pop())
    .then(() => true).catch(() => false);
  try {
    const { stream, done } = rc().upload(mapped.remote);
    req.pipe(stream);
    await done;
    const headers = existed ? {} : { Location: hrefOf(mapped.urlPath) };
    res.writeHead(existed ? 204 : 201, headers);
    res.end();
  } catch (err) {
    console.error("put failed:", err.message);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("upstream unavailable");
    } else res.destroy();
  }
}

async function handleDelete(req, res) {
  const mapped = mapPath(req.url);
  if (!mapped || mapped.urlPath === "/") {
    res.writeHead(403, { "Content-Type": "text/plain" });
    return res.end("cannot DELETE root");
  }
  if (!await precond(req, res, mapped.urlPath, mapped.remote)) return;
  try {
    await entryAt(mapped.remote, mapped.urlPath.split("/").filter(Boolean).pop());
  } catch (err) {
    res.writeHead(err.code === "ENOTFOUND" ? 404 : 502, { "Content-Type": "text/plain" });
    return res.end(err.code === "ENOTFOUND" ? "not found" : "upstream unavailable");
  }
  try {
    await rc().remove(mapped.remote, { recursive: true });
    res.writeHead(204);
    res.end();
  } catch (err) {
    console.error("delete failed:", err.message);
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("upstream unavailable");
  }
}

async function handleMkcol(req, res) {
  const mapped = mapPath(req.url);
  if (!mapped || mapped.urlPath === "/") {
    res.writeHead(405, { "Content-Type": "text/plain" });
    return res.end("exists");
  }
  const body = await readBody(req).catch(() => null);
  if (body == null) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    return res.end("error");
  }
  if (body.trim()) {
    res.writeHead(415, { "Content-Type": "text/plain" });
    return res.end("MKCOL with body unsupported");
  }
  const parentUrl = mapped.urlPath.split("/").slice(0, -1).join("/") || "/";
  const parentRemote = mapped.remote.split("/").slice(0, -1).join("/") || "/";
  if (parentUrl !== "/") {
    try {
      const pe = await entryAt(parentRemote, parentUrl.split("/").filter(Boolean).pop());
      if (!pe.isDir) throw Object.assign(new Error("conflict"), { code: "ENOTFOUND" });
    } catch {
      res.writeHead(409, { "Content-Type": "text/plain" });
      return res.end("parent missing");
    }
  }
  try {
    await entryAt(mapped.remote, mapped.urlPath.split("/").filter(Boolean).pop());
    res.writeHead(405, { "Content-Type": "text/plain" });
    return res.end("exists");
  } catch (err) {
    if (err.code !== "ENOTFOUND") {
      res.writeHead(502, { "Content-Type": "text/plain" });
      return res.end("upstream unavailable");
    }
  }
  try {
    await rc().mkdir(mapped.remote);
    res.writeHead(201);
    res.end();
  } catch (err) {
    console.error("mkcol failed:", err.message);
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("upstream unavailable");
  }
}

function parseDestination(req, res) {
  const raw = req.headers.destination;
  if (!raw) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Destination required");
    return null;
  }
  let dest;
  try {
    const u = new URL(raw, `http://${req.headers.host ?? "x"}`);
    const reqHost = (req.headers.host ?? "").split(",")[0].trim();
    if (raw.includes("://") && u.host && u.host !== reqHost) {
      // Cross-host copy/move: refuse (server-side request forgery guard).
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("cross-host destination refused");
      return null;
    }
    dest = decodeURIComponent(u.pathname);
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("bad Destination");
    return null;
  }
  const norm = path.posix.normalize("/" + dest);
  if (norm.includes("\0")) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("bad Destination");
    return null;
  }
  return norm;
}

async function handleCopyMove(req, res, isMove) {
  const mapped = mapPath(req.url);
  if (!mapped || mapped.urlPath === "/") {
    res.writeHead(403, { "Content-Type": "text/plain" });
    return res.end("cannot copy root");
  }
  const destUrl = parseDestination(req, res);
  if (!destUrl) return;
  if (!await precond(req, res, mapped.urlPath, mapped.remote)) return;
  let src;
  try {
    src = await entryAt(mapped.remote, mapped.urlPath.split("/").filter(Boolean).pop());
  } catch (err) {
    res.writeHead(err.code === "ENOTFOUND" ? 404 : 502, { "Content-Type": "text/plain" });
    return res.end(err.code === "ENOTFOUND" ? "not found" : "upstream unavailable");
  }
  const depth = (req.headers.depth ?? "infinity").trim();
  if (src.isDir && depth !== "infinity") {
    res.writeHead(400, { "Content-Type": "text/plain" });
    return res.end("Depth: infinity required for collections");
  }
  const destRemote = ((config.BASE_PATH ?? "") + destUrl).replace(/\/+/g, "/").replace(/\/$/, "") || "/";
  if (destRemote === mapped.remote) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    return res.end("source == destination");
  }
  if (!await precond(req, res, destUrl, destRemote)) return;
  const overwrite = (req.headers.overwrite ?? "T").trim().toUpperCase() !== "F";
  const destExists = await entryAt(destRemote, destUrl.split("/").filter(Boolean).pop())
    .then(() => true).catch(() => false);
  if (destExists && !overwrite) {
    res.writeHead(412, { "Content-Type": "text/plain" });
    return res.end("destination exists");
  }
  try {
    if (isMove) await rc().move(mapped.remote, destRemote);
    else await rc().copy(mapped.remote, destRemote);
    if (isMove) {
      // Move locks with the resource.
      // (Locks keyed by URL path do not auto-migrate; acceptable v1 scope.)
    }
    res.writeHead(destExists ? 204 : 201);
    res.end();
  } catch (err) {
    console.error(`${isMove ? "move" : "copy"} failed:`, err.message);
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("upstream unavailable");
  }
}

function parseTimeout(header) {
  const cap = config.LOCK_TIMEOUT_MAX > 0 ? config.LOCK_TIMEOUT_MAX : 86400;
  const m = /Second-(\d+)/i.exec(header ?? "");
  if (m) return Math.min(Number(m[1]), cap);
  if (/infinite/i.test(header ?? "")) return cap;
  return Math.min(3600, cap);
}

function parseLockInfo(body) {
  const scope = /<(\w*:)?shared\s*\/?>/.test(body) ? "shared" : "exclusive";
  const ownerM = body.match(/<(\w*:)?owner[^>]*>([\s\S]*?)<\/(\w*:)?owner>/);
  const owner = ownerM ? ownerM[2].replace(/<[^>]+>/g, "").trim().slice(0, 200) : "";
  return { scope, owner };
}

async function handleLock(req, res) {
  const mapped = mapPath(req.url);
  if (!mapped || mapped.urlPath === "/") {
    res.writeHead(403, { "Content-Type": "text/plain" });
    return res.end("cannot lock root");
  }
  const body = await readBody(req).catch(() => null);
  if (body == null) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    return res.end("error");
  }
  if (!body.trim()) {
    // Refresh: If header must carry the token.
    const lists = parseIf(req.headers.if);
    const toks = lists.flatMap((l) => l.tokens.filter((t) => !t.negated).map((t) => t.token));
    const hit = refreshLock(mapped.urlPath, toks);
    if (!hit) {
      res.writeHead(412, { "Content-Type": "text/plain" });
      return res.end("no matching lock");
    }
    res.writeHead(200, {
      "Content-Type": "application/xml; charset=utf-8",
      "Lock-Token": `<${hit.token}>`,
    });
    return res.end(lockResponseXml(mapped.urlPath, hit));
  }
  const { scope, owner } = parseLockInfo(body);
  const depth = (req.headers.depth ?? "infinity").trim();
  if (!["0", "infinity"].includes(depth)) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    return res.end("bad Depth");
  }
  const timeoutSecs = parseTimeout(req.headers.timeout);
  const { lock, conflict } = store.lock(mapped.urlPath, { owner, scope, depth, timeoutSecs });
  if (conflict) {
    res.writeHead(423, { "Content-Type": "application/xml; charset=utf-8" });
    return res.end(lockedXml(mapped.urlPath));
  }
  activeLocks.set(mapped.urlPath, lock);
  res.writeHead(200, {
    "Content-Type": "application/xml; charset=utf-8",
    "Lock-Token": `<${lock.token}>`,
  });
  res.end(lockResponseXml(mapped.urlPath, lock));
}

function refreshLock(urlPath, toks) {
  const l = activeLocks.get(urlPath);
  if (!l) return null;
  if (!toks.includes(l.token) && !toks.includes(`<${l.token}>`)) return null;
  l.expiresAt = Date.now() + 3600 * 1000;
  store.lock(urlPath, { owner: l.owner, scope: l.scope, depth: l.depth, timeoutSecs: 3600 });
  const updated = { ...l, expiresAt: Date.now() + 3600 * 1000 };
  activeLocks.set(urlPath, updated);
  return updated;
}

function lockResponseXml(urlPath, lock) {
  return `<?xml version="1.0" encoding="utf-8"?>`
    + `<D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock>`
    + `<D:locktype><D:write/></D:locktype>`
    + `<D:lockscope><D:${lock.scope}/></D:lockscope>`
    + `<D:depth>${esc(lock.depth)}</D:depth>`
    + `<D:owner>${esc(lock.owner)}</D:owner>`
    + `<D:timeout>Second-${Math.max(0, Math.round((lock.expiresAt - Date.now()) / 1000))}</D:timeout>`
    + `<D:locktoken><D:href>${esc(lock.token)}</D:href></D:locktoken>`
    + `</D:activelock></D:lockdiscovery></D:prop>`;
}

async function handleUnlock(req, res) {
  const mapped = mapPath(req.url);
  if (!mapped) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    return res.end("bad path");
  }
  const m = /Lock-Token\s*:\s*(<urn:uuid:[^>]+>|urn:uuid:[^,\s]+)/i.exec(
    `Lock-Token: ${req.headers["lock-token"] ?? ""}`);
  const token = m ? m[1].replace(/^<|>$/g, "") : null;
  if (!token || !store.unlock(mapped.urlPath, token)) {
    res.writeHead(409, { "Content-Type": "text/plain" });
    return res.end("no matching lock");
  }
  activeLocks.delete(mapped.urlPath);
  res.writeHead(204);
  res.end();
}

async function handleProppatch(req, res) {
  const mapped = mapPath(req.url);
  if (!mapped || mapped.urlPath === "/") {
    res.writeHead(403, { "Content-Type": "text/plain" });
    return res.end("cannot patch root");
  }
  if (!await precond(req, res, mapped.urlPath, mapped.remote)) return;
  try {
    await entryAt(mapped.remote, mapped.urlPath.split("/").filter(Boolean).pop());
  } catch (err) {
    res.writeHead(err.code === "ENOTFOUND" ? 404 : 502, { "Content-Type": "text/plain" });
    return res.end(err.code === "ENOTFOUND" ? "not found" : "upstream unavailable");
  }
  const body = await readBody(req).catch(() => null);
  if (body == null) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    return res.end("error");
  }
  // set/remove blocks with Clark-ish tags; live (DAV:) props are protected.
  const sets = [];
  const rems = [];
  const nsmap = namespacesOf(body);
  const blockRe = /<(\w*:)?(set|remove)[^>]*>([\s\S]*?)<\/(\w*:)?(set|remove)>/g;
  let b;
  while ((b = blockRe.exec(body))) {
    const inner = b[3];
    const propM = inner.match(/<(\w*:)?prop[^>]*>([\s\S]*?)<\/(\w*:)?prop>/);
    if (!propM) continue;
    const tagRe = /<((?:\w+:)?[\w.-]+)(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/\1>)/g;
    let t;
    while ((t = tagRe.exec(propM[2]))) {
      const full = clark(nsmap, "DAV:", t[1]);
      (b[2].toLowerCase() === "set" ? sets : rems).push([full, (t[2] ?? "").trim()]);
    }
  }
  const ok = [];
  const forbidden = [];
  const applySet = new Map();
  for (const [k, v] of sets) {
    if (k.startsWith("{DAV:}")) forbidden.push(k);
    else applySet.set(k, v);
  }
  const applyRem = [];
  for (const [k] of rems) {
    if (k.startsWith("{DAV:}")) forbidden.push(k);
    else applyRem.push(k);
  }
  if (applySet.size) store.setProps(mapped.urlPath, [...applySet.entries()]);
  if (applyRem.length) store.setProps(mapped.urlPath, applyRem.map((k) => [k, null]));
  const item = (keys, status) => {
    if (!keys.length) return "";
    const tags = keys.map((k) => {
      const m = k.match(/^\{([^}]*)\}(.*)$/);
      const ns = m ? m[1] : "DAV:";
      const local = m ? m[2] : k;
      return `<${ns === "DAV:" ? "D" : "Z"}:${esc(local)}/>`;
    }).join("");
    return `<D:response><D:href>${esc(hrefOf(mapped.urlPath))}</D:href>`
      + `<D:propstat><D:prop>${tags}</D:prop><D:status>HTTP/1.1 ${status}</D:status></D:propstat></D:response>`;
  };
  sendXml(res, 207, multistatusRaw(
    item([...applySet.keys(), ...applyRem], "200 OK")
    + item(forbidden, "403 Forbidden")
  ));
}

function multistatusRaw(inner) {
  return `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${inner}</D:multistatus>`;
}

export function createServer() {
  return http.createServer((req, res) => {
    if (!authed(req, res)) return deny(res);
    const method = (req.method ?? "GET").toUpperCase();
    const done = (err) => {
      console.error(`${method.toLowerCase()} failed:`, err?.message ?? err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("error");
      }
    };
    if (method === "OPTIONS") {
      res.writeHead(200, {
        DAV: "1, 2",
        Allow: "OPTIONS, PROPFIND, PROPPATCH, GET, HEAD, PUT, DELETE, MKCOL, COPY, MOVE, LOCK, UNLOCK",
        "Content-Length": "0",
      });
      return res.end();
    }
    if (method === "PROPFIND") return handlePropfind(req, res).catch(done);
    if (method === "PROPPATCH") return handleProppatch(req, res).catch(done);
    if (method === "HEAD") return handleGet(req, res, true).catch(done);
    if (method === "GET") return handleGet(req, res, false).catch(done);
    if (method === "PUT") return handlePut(req, res).catch(done);
    if (method === "DELETE") return handleDelete(req, res).catch(done);
    if (method === "MKCOL") return handleMkcol(req, res).catch(done);
    if (method === "COPY") return handleCopyMove(req, res, false).catch(done);
    if (method === "MOVE") return handleCopyMove(req, res, true).catch(done);
    if (method === "LOCK") return handleLock(req, res).catch(done);
    if (method === "UNLOCK") return handleUnlock(req, res).catch(done);
    res.writeHead(501, { "Content-Type": "text/plain" });
    res.end("unsupported method");
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!config.DAV_USER) console.error("warning: no DAV_USER set — open access (local dev only)");
  createServer().listen(config.PORT, () => {
    console.log(`terabox-webdav on :${config.PORT} (full WebDAV, remote=${config.RCLONE_REMOTE})`);
  });
}
