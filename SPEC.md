# TeraBox as WebDAV — Draft Spec

**Status:** draft · **Goal:** expose a TeraBox account as a standard WebDAV
server (browse, stream with seeking, optional upload) so any WebDAV client —
file managers, media players, backup tools — can use 1TB TeraBox as a drive.

## Background (verified)

- TeraBox has no official WebDAV/API for third parties; access is via the
  `ndus` login cookie (expires periodically, must be refreshed).
- `rclone-extra` (gulp79 fork) ships a working `terabox` backend: `about`,
  listing, download, **upload** (~1.5–3MB/s/file on free accounts), mount —
  verified live against a real 1TB account.
- `rclone serve webdav` is proven in production here (served the SoulSeek
  downloads volume: PROPFIND + Range + basic-auth all good).
- Known upstream flakiness: session/key expiry mid-mount, occasional mount
  freezes, TLS handshake timeouts under load (see rclone PR #8508 thread).

## Chosen approach: rclone serve webdav over terabox remote

No custom WebDAV server code. rclone already implements the full RFC
(PROPFIND/PROPPATCH/GET/PUT/DELETE/MKCOL/MOVE/COPY/LOCK) and translates to
TeraBox API calls. We compose proven pieces instead of re-implementing WebDAV.

```
WebDAV client (Solid Explorer / Finder / mpv / BitChord?)
  │  HTTPS + basic-auth, Range requests
  ▼
Caddy :443 (TLS, basicauth, optional path prefix)
  │  http://127.0.0.1:8085
  ▼
rclone serve webdav terabox:/  (systemd, Restart=always)
  │  terabox backend, ndus cookie, VFS cache
  ▼
TeraBox (1TB)
```

### Why not the alternatives

| Option | Verdict |
|---|---|
| Custom Flask WebDAV (à la terabox-gateway) | Re-implements RFC 4918 + locking + ranges; months of edge cases rclone already handles. Reject. |
| `rclone mount` + generic WebDAV server (wsgidav) on top | Double translation (WebDAV→FUSE→API), FUSE as SPOF, AppArmor fights (seen live). Reject. |
| rclone `serve webdav` direct | Single translation, no FUSE, no kernel deps. **Accept.** |

## Configuration

```ini
# /root/.config/rclone/rclone.conf (chmod 600)
[terabox]
type = terabox
cookie = <ndus value from terabox.com → F12 → Application → Cookies>
```

```bash
# serve (systemd unit: deploy/rclone-terabox-webdav-serve.service — cf. soulseek-addon/deploy/)
rclone serve webdav terabox:/ \
  --config /root/.config/rclone/rclone.conf \
  --addr 127.0.0.1:8085 \
  --read-only \                 # drop for read-write (uploads enabled)
  --vfs-cache-mode full \       # hot chunks local; cold fetched on demand
  --vfs-cache-max-size 2G \
  --vfs-cache-max-age 24h \
  --dir-cache-time 5m \
  --log-level NOTICE
```

Caddy (same pattern as live `/dav` route):

```caddy
handle /tb/* {
    basicauth {
        <user> <bcrypt-hash>   # caddy hash-password
    }
    uri strip_prefix /tb
    reverse_proxy 127.0.0.1:8085
}
```

## Behavior contract

- **Browse:** PROPFIND directory listings, paged by rclone (large TeraBox dirs are slow on first hit — dir-cache warms it).
- **Stream/seek:** HTTP Range fully supported; players scrub normally. First byte pays TeraBox latency; VFS cache absorbs repeats (bounded by `vfs-cache-max-size`).
- **Upload (read-write mode):** free accounts ~1.5–3MB/s per file, several in parallel; large files chunk through VFS — async from the client's view after cache accept.
- **Auth model:** WebDAV basic-auth (Caddy) is independent of the `ndus` cookie. Rotate either without touching the other.
- **Cookie expiry:** `ndus` dies periodically → all operations 401 → refresh cookie in `rclone.conf`, `systemctl restart`. TODO: probe endpoint + alerting (watchdog checks `rclone about` exit code hourly).

## Failure modes (observed + expected)

| Symptom | Cause | Mitigation |
|---|---|---|
| Mount/serve stalls, TLS timeouts | TeraBox session/key expiry, upstream protection | systemd `Restart=always`; re-auth on 401s; backoff |
| Slow first listing of huge dirs | Uncached dir walk over API | `--dir-cache-time`, `--fast-list` where supported |
| Upload slower than web UI | Free-account per-file throttle | Parallel transfers; accept ~10MB/s aggregate |
| Cookie dead | Periodic expiry | Documented refresh flow; TODO auto-detect + alert |

## Open questions

1. Read-only vs read-write for v1? (Recommend: read-only first, uploads after a soak week.)
2. Single shared login or per-user WebDAV users? (Caddy basicauth supports many; all map to one TeraBox account either way.)
3. Quota guard: TeraBox is 1TB — do we need prune/retention on this store, or is it the archive of last resort? (Recommend: no auto-delete v1.)
4. BitChord as a WebDAV *client* — does its source type accept authed WebDAV URLs with Range? To verify against a real app build.

## Definition of done (v1)

- [ ] `rclone serve webdav` unit running + supervised on the VPS
- [ ] Caddy route with basic-auth, HTTPS
- [ ] PROPFIND + Range GET verified from an external client
- [ ] Cookie-refresh runbook written (exact clicks)
- [ ] This spec marked `Status: accepted`
