# terabox-webdav — TeraBox account as a full WebDAV drive

A zero-dependency Node WebDAV server (complete RFC 4918: every verb) backed by
an [rclone](https://github.com/gulp79/rclone-extra) `terabox` remote. Your
TeraBox account appears as a plain drive: browse, stream with seeking, upload,
rename, delete, lock — from any WebDAV client. This box holds no bytes.

```
WebDAV client ──HTTPS + basic-auth──► terabox-webdav ──rclone CLI──► TeraBox
                                       (this repo)      (ndus cookie)
```

## Quickstart

```bash
# 1. rclone with a terabox remote (see soulseek-addon/deploy/terabox-setup.sh)
#    — needs your TeraBox ndus cookie (terabox.com → F12 → Application → Cookies)
cp .env.example .env   # set RCLONE_CONFIG + RCLONE_REMOTE at minimum
node src/server.js     # :8086
npm test
```

```bash
# .env
RCLONE_BIN=rclone
RCLONE_CONFIG=/root/.config/rclone/rclone.conf
RCLONE_REMOTE=terabox:
RCLONE_BASE_PATH=/
DAV_USER=slsk
DAV_PASS=change-me
```

## What's supported

| Method | Behavior |
|---|---|
| `OPTIONS` | `DAV: 1, 2` + full `Allow` list |
| `PROPFIND` | Depth 0/1 (infinity refused: unbounded walks over a network remote); `allprop`, `propname`, named props incl. dead props, `getetag`, locks |
| `GET` / `HEAD` | Byte ranges via `rclone cat --offset/--count`; correct MIME + `Accept-Ranges`; `416` on bad ranges |
| `PUT` | streamed upload (`rcat`); `201` new / `204` overwrite; `If-None-Match: *` → `412` if exists |
| `DELETE` | file or recursive collection; root protected |
| `MKCOL` | `201` / `405` exists / `409` missing parent / `415` non-empty body |
| `COPY` / `MOVE` | same-host `Destination` only (SSRF guard); `Overwrite: F` → `412`; collections need `Depth: infinity` |
| `LOCK` / `UNLOCK` | exclusive + shared, owner, timeout (capped), refresh via `If`, `423` with lock info on conflict |
| `PROPPATCH` | dead props set/remove (`207` per-prop); live `DAV:` props → `403` |
| Preconditions | `If` header (lock tokens + etags): `423` locked, `412` failed |

Locks + dead props live in-process (single instance owns them), optionally
persisted to `PROP_STORE` JSON across restarts.

## Clients

Solid/Cx File Explorer (Android), Finder → Connect to Server (Mac),
`rclone`/`davfs2` (Linux), mpv/VLC (direct file URLs). Behind Caddy for
public HTTPS + an extra basic-auth layer:

```caddy
handle /tb/* {
    basicauth { <user> <bcrypt-hash> }   # caddy hash-password
    uri strip_prefix /tb
    reverse_proxy 127.0.0.1:8086
}
```

## Limits (honest)

- Every op shells to rclone (~200–500ms each) — fine for files, not for
  thousands-of-files sync tools.
- Free-account TeraBox: ~1.5–3MB/s per file; session/key expiry mid-mount
  happens upstream — retries + re-auth surface as 502s, refresh the cookie.
- No `Depth: infinity` PROPFIND (refused 403); clients paginate depth:1.
- Single-instance locks: don't run two servers against one remote.
