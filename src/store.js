import fs from "node:fs";

// In-memory WebDAV lock manager (RFC 4918 §14) + dead property store.
// Single-instance scope: one server process owns all locks, which matches
// our deployment (one container). State optionally persists to JSON so a
// restart doesn't orphan client locks mid-edit.
export function createStore(persistPath = "") {
  const locks = new Map(); // path -> { token, owner, scope, type, depth, expiresAt }
  const props = new Map(); // path -> Map(propKey -> xml string)

  const store = {
    lock(path, { owner = "", scope = "exclusive", depth = "infinity", timeoutSecs = 3600 }) {
      const now = Date.now();
      for (const [p, l] of locks) {
        if (l.expiresAt <= now) locks.delete(p);
      }
      const existing = locks.get(path);
      if (existing && existing.expiresAt > now && !(existing.scope === "shared" && scope === "shared")) {
        return { conflict: existing };
      }
      const token = `urn:uuid:${randomUuid()}`;
      const lock = { token, owner, scope, type: "write", depth, expiresAt: now + timeoutSecs * 1000 };
      locks.set(path, lock);
      save();
      return { lock };
    },
    unlock(path, token) {
      const l = locks.get(path);
      if (!l) return false;
      if (l.token !== token) return false;
      locks.delete(path);
      save();
      return true;
    },
    // A write/remove to path (or its children, for depth:infinity collection
    // locks) is blocked when a live lock without a matching token exists.
    lockedByOther(path, tokens) {
      const now = Date.now();
      const check = (p) => {
        const l = locks.get(p);
        if (!l) return null;
        if (l.expiresAt <= now) {
          locks.delete(p);
          return null;
        }
        if (l.depth === "infinity" && path !== p && !path.startsWith(p.endsWith("/") ? p : p + "/")) return null;
        if (tokens.includes(`<${l.token}>`) || tokens.includes(l.token)) return null;
        return l;
      };
      // Exact path plus every ancestor (a locked collection locks members).
      let hit = check(path);
      if (hit) return hit;
      const segs = path.split("/").filter(Boolean);
      for (let i = segs.length - 1; i >= 0; i--) {
        hit = check("/" + segs.slice(0, i).join("/"));
        if (hit) return hit;
      }
      return null;
    },
    setProps(path, map) {
      if (!props.has(path)) props.set(path, new Map());
      const m = props.get(path);
      for (const [k, v] of map) {
        if (v === null) m.delete(k);
        else m.set(k, v);
      }
      save();
    },
    getProps(path) {
      return props.get(path) ?? new Map();
    },
  };

  function save() {
    if (!persistPath) return;
    try {
      fs.writeFileSync(persistPath, JSON.stringify({
        locks: [...locks.entries()],
        props: [...props.entries()].map(([k, m]) => [k, [...m.entries()]]),
      }));
    } catch { /* best effort */ }
  }

  function load() {
    if (!persistPath) return;
    try {
      const d = JSON.parse(fs.readFileSync(persistPath, "utf8"));
      for (const [k, v] of d.locks ?? []) locks.set(k, v);
      for (const [k, v] of d.props ?? []) props.set(k, new Map(v));
    } catch { /* fresh start */ }
  }

  load();
  return store;
}

function randomUuid() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Parse If: header into [{ path, tokens, etags }] (RFC 4918 §10.4, common
// subset: tagged/untagged lists, lock tokens, etags, Not).
export function parseIf(header) {
  if (!header) return [];
  const out = [];
  const re = /(?:<([^>]+)>\s*)?(\([^)]+\))/g;
  let m;
  while ((m = re.exec(header))) {
    const inner = m[2].slice(1, -1).trim();
    const tokens = [];
    const etags = [];
    const tre = /(Not\s+)?(<urn:uuid:[^>]+>|\[[^\]]+\])/g;
    let t;
    while ((t = tre.exec(inner))) {
      const negated = Boolean(t[1]);
      const body = t[2];
      if (body.startsWith("<")) tokens.push({ token: body.slice(1, -1), negated });
      else etags.push({ etag: body.slice(1, -1), negated });
    }
    out.push({ path: m[1] ?? null, tokens, etags });
  }
  return out;
}

// Evaluate If preconditions for a resource with current etag. Returns
// "ok", "locked" (→423) or "precondition" (→412).
export function checkIf(store, path, currentEtag, header) {
  const lists = parseIf(header);
  if (!lists.length) {
    return store.lockedByOther(path, []) ? "locked" : "ok";
  }
  let sawLockFailure = false;
  for (const list of lists) {
    const target = list.path ?? path;
    const etagOk = list.etags.every((e) => e.negated
      ? (e.etag === "*" ? currentEtag == null : e.etag !== currentEtag)
      : (e.etag === "*" || e.etag === currentEtag));
    if (!etagOk) continue;
    const toks = list.tokens.filter((t) => !t.negated).map((t) => t.token);
    if (store.lockedByOther(target, toks)) {
      sawLockFailure = true;
      continue;
    }
    return "ok";
  }
  return sawLockFailure ? "locked" : "precondition";
}
