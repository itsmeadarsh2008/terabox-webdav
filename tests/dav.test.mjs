import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

process.env.DAV_USER = "u";
process.env.DAV_PASS = "p";
process.env.TERABOX_GATEWAY_URL = "http://localhost:1"; // replaced below
process.env.TERABOX_SHARES = "Music|https://teraboxshare.com/s/abc,https://terabox.com/s/def";
process.env.PORT = "0";

const SHARE_A = "https://teraboxshare.com/s/abc";
const gw = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api" && url.searchParams.get("url") === SHARE_A) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ status: "success", files: [
      { filename: "RADWIMPS - Suzume (feat. Toaka).flac", size: 53670639, download_link: "https://dl.example/s.flac" },
      { filename: "cover.jpg", size: 999, download_link: "https://dl.example/c.jpg" },
    ] }));
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "error", message: "not found" }));
});
await new Promise((r) => gw.listen(0, r));
process.env.TERABOX_GATEWAY_URL = `http://localhost:${gw.address().port}`;

const { createServer } = await import("../src/server.js");
const srv = createServer();
await new Promise((r) => srv.listen(0, r));
after(() => { srv.close(); gw.close(); });
const base = `http://localhost:${srv.address().port}`;
const auth = { Authorization: "Basic " + Buffer.from("u:p").toString("base64") };

async function req(method, path, headers = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...auth, ...headers },
  });
  return { status: res.status, text: await res.text(), headers: res.headers };
}

test("OPTIONS advertises DAV", async () => {
  const r = await req("OPTIONS", "/");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("dav") ?? "", /1/);
});

test("401 without auth", async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 401);
});

test("root PROPFIND lists collections", async () => {
  const r = await req("PROPFIND", "/");
  assert.equal(r.status, 207);
  assert.ok(r.text.includes("Music"));
  assert.ok(r.text.includes("share-2"));
});

test("share PROPFIND lists files", async () => {
  const r = await req("PROPFIND", "/Music/");
  assert.equal(r.status, 207);
  assert.ok(r.text.includes("Suzume"));
  assert.ok(r.text.includes("53670639"));
});

test("missing share 404s", async () => {
  const r = await req("PROPFIND", "/nope/");
  assert.equal(r.status, 404);
});

test("GET redirects to gateway link (redirect mode)", async () => {
  const res = await fetch(`${base}/Music/${encodeURIComponent("RADWIMPS - Suzume (feat. Toaka).flac")}`, {
    headers: auth, redirect: "manual",
  });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "https://dl.example/s.flac");
});

test("HEAD exposes type + length", async () => {
  const r = await req("HEAD", "/Music/" + encodeURIComponent("RADWIMPS - Suzume (feat. Toaka).flac"));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "audio/flac");
  assert.equal(r.headers.get("content-length"), "53670639");
});

test("unknown file 404s", async () => {
  const r = await req("GET", "/Music/nope.flac");
  assert.equal(r.status, 404);
});
