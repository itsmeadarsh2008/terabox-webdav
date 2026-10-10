import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "dav-remote-"));
fs.mkdirSync(path.join(ROOT, "docs"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "docs", "readme.txt"), "hello-webdav");
fs.writeFileSync(path.join(ROOT, "song.flac"), "FAKEFLACBYTES0123456789");

process.env.RCLONE_BIN = new URL("./helpers/stub-rclone.mjs", import.meta.url).pathname;
process.env.STUB_ROOT = ROOT;
process.env.RCLONE_REMOTE = "stub:";
process.env.RCLONE_BASE_PATH = "/";
process.env.DAV_USER = "u";
process.env.DAV_PASS = "p";
process.env.PORT = "0";

const { createServer } = await import("../src/server.js");
const srv = createServer();
await new Promise((r) => srv.listen(0, r));
after(() => {
  srv.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
});
const base = `http://localhost:${srv.address().port}`;
const auth = { Authorization: "Basic " + Buffer.from("u:p").toString("base64") };

async function req(method, p, { headers = {}, body = null } = {}) {
  const res = await fetch(`${base}${p}`, { method, headers: { ...auth, ...headers }, body });
  return { status: res.status, text: await res.text(), headers: res.headers };
}

test("OPTIONS advertises full method set", async () => {
  const r = await req("OPTIONS", "/");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("dav") ?? "", /2/);
  assert.match(r.headers.get("allow") ?? "", /LOCK/);
  assert.match(r.headers.get("allow") ?? "", /PROPPATCH/);
});

test("401 without auth", async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 401);
});

test("root PROPFIND depth:1 lists collections+files", async () => {
  const r = await req("PROPFIND", "/", { headers: { Depth: "1" } });
  assert.equal(r.status, 207);
  assert.ok(r.text.includes("docs"));
  assert.ok(r.text.includes("song.flac"));
});

test("PROPFIND depth:infinity refused", async () => {
  const r = await req("PROPFIND", "/", { headers: { Depth: "infinity" } });
  assert.equal(r.status, 403);
});

test("propname works", async () => {
  const r = await req("PROPFIND", "/docs", {
    headers: { Depth: "0", "Content-Type": "application/xml" },
    body: `<?xml version="1.0"?><propfind xmlns="DAV:"><propname/></propfind>`,
  });
  assert.equal(r.status, 207);
  assert.ok(r.text.includes("resourcetype"));
});

test("GET full file + HEAD", async () => {
  const g = await req("GET", "/docs/readme.txt");
  assert.equal(g.status, 200);
  assert.equal(g.text, "hello-webdav");
  const h = await req("HEAD", "/docs/readme.txt");
  assert.equal(h.status, 200);
  assert.equal(h.headers.get("content-length"), String("hello-webdav".length));
});

test("GET Range slices bytes", async () => {
  const r = await req("GET", "/docs/readme.txt", { headers: { Range: "bytes=0-4" } });
  assert.equal(r.status, 206);
  assert.equal(r.text, "hello");
  assert.equal(r.headers.get("content-range"), "bytes 0-4/12");
});

test("PUT roundtrip then PROPPATCH dead props", async () => {
  const put = await req("PUT", "/docs/note.txt", { body: "take notes" });
  assert.ok([201, 204].includes(put.status));
  const get = await req("GET", "/docs/note.txt");
  assert.equal(get.text, "take notes");
  const pp = await req("PROPPATCH", "/docs/note.txt", {
    headers: { "Content-Type": "application/xml" },
    body: `<?xml version="1.0"?><propertyupdate xmlns:D="DAV:" xmlns:Z="urn:x"><D:set><D:prop><Z:mood>calm</Z:mood></D:prop></D:set><D:remove><D:prop><Z:gone/></D:prop></D:remove></propertyupdate>`,
  });
  assert.equal(pp.status, 207);
  assert.ok(pp.text.includes("200 OK"));
  const prop = await req("PROPFIND", "/docs/note.txt", {
    headers: { Depth: "0", "Content-Type": "application/xml" },
    body: `<?xml version="1.0"?><propfind xmlns:D="DAV:" xmlns:Z="urn:x"><D:prop><Z:mood/></D:prop></D:propfind>`,
  });
  assert.ok(prop.text.includes("calm"));
  const del = await req("DELETE", "/docs/note.txt");
  assert.equal(del.status, 204);
});

test("MKCOL lifecycle: 409 without parent, 201, 405 exists, 415 body", async () => {
  const missing = await req("MKCOL", "/nodir/sub");
  assert.equal(missing.status, 409);
  const mk = await req("MKCOL", "/newdir");
  assert.equal(mk.status, 201);
  const again = await req("MKCOL", "/newdir");
  assert.equal(again.status, 405);
  const body = await req("MKCOL", "/newdir2", { body: "<x/>" });
  assert.equal(body.status, 415);
  const del = await req("DELETE", "/newdir");
  assert.equal(del.status, 204);
});

test("COPY honors Overwrite:F with 412", async () => {
  await req("PUT", "/docs/a.txt", { body: "AAA" });
  await req("PUT", "/docs/b.txt", { body: "BBB" });
  const clash = await req("COPY", "/docs/a.txt", {
    headers: { Destination: "/docs/b.txt", Overwrite: "F" },
  });
  assert.equal(clash.status, 412);
  const ok = await req("COPY", "/docs/a.txt", { headers: { Destination: "/docs/c.txt" } });
  assert.equal(ok.status, 201);
  const got = await req("GET", "/docs/c.txt");
  assert.equal(got.text, "AAA");
});

test("MOVE relocates", async () => {
  const mv = await req("MOVE", "/docs/c.txt", { headers: { Destination: "/moved.txt" } });
  assert.ok([201, 204].includes(mv.status));
  assert.equal((await req("GET", "/docs/c.txt")).status, 404);
  assert.equal((await req("GET", "/moved.txt")).text, "AAA");
  await req("DELETE", "/moved.txt");
  await req("DELETE", "/docs/a.txt");
  await req("DELETE", "/docs/b.txt");
});

test("LOCK exclusive blocks others, token opens, UNLOCK releases", async () => {
  const lock = await req("LOCK", "/docs/readme.txt", {
    headers: { Depth: "0", Timeout: "Second-300", "Content-Type": "application/xml" },
    body: `<?xml version="1.0"?><lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype><D:owner>tester</D:owner></D:lockinfo>`,
  });
  assert.equal(lock.status, 200);
  const token = lock.headers.get("lock-token");
  assert.ok(token?.includes("urn:uuid:"));
  const second = await req("LOCK", "/docs/readme.txt", {
    headers: { Depth: "0", "Content-Type": "application/xml" },
    body: `<?xml version="1.0"?><lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>`,
  });
  assert.equal(second.status, 423);
  const blocked = await req("PUT", "/docs/readme.txt", { body: "hijack" });
  assert.equal(blocked.status, 423);
  const allowed = await req("PUT", "/docs/readme.txt", {
    headers: { If: `(${token})` }, body: "hijack",
  });
  assert.equal(allowed.status, 204);
  // restore fixture content for other tests
  await req("PUT", "/docs/readme.txt", { headers: { If: `(${token})` }, body: "hello-webdav" });
  const stale = await req("PUT", "/docs/readme.txt", { headers: { If: `(["stale-etag"])` } });
  assert.equal(stale.status, 412);
  const un = await req("UNLOCK", "/docs/readme.txt", { headers: { "Lock-Token": token } });
  assert.equal(un.status, 204);
  const after = await req("PUT", "/docs/readme.txt", { body: "hello-webdav" });
  assert.equal(after.status, 204);
});
