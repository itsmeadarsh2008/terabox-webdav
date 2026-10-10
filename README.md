# terabox-webdav — TeraBox shares as a WebDAV drive

A zero-dependency Node WebDAV frontend for TeraBox. It exposes your TeraBox
**share URLs** as browsable collections and playable files by talking to
[terabox-gateway](https://github.com/saahiyo/terabox-gateway) — which holds
your TeraBox login. This server never sees your TeraBox credentials.

```
WebDAV client ──HTTPS + basic-auth──► terabox-webdav ──► terabox-gateway ──► TeraBox
                                       (this repo)          (ndus cookie lives here)
```

## Quickstart

```bash
cp .env.example .env   # set TERABOX_SHARES at minimum
node src/server.js     # :8086
npm test
```

```bash
# .env
TERABOX_GATEWAY_URL=http://localhost:5000
TERABOX_SHARES=Music|https://teraboxshare.com/s/XXXX,https://terabox.com/s/YYYY
DAV_USER=slsk
DAV_PASS=change-me
```

## How it works

- **Catalog:** `TERABOX_SHARES` entries (`Label|url`) become top-level
  collections (`/Music/`). No search — matching happens in the client
  (or in frontends like the soulseek-addon TeraBox backend).
- **`PROPFIND /`** lists collections; **`PROPFIND /Label/`** lists that
  share's files live from the gateway (name + size).
- **`GET /Label/file`** → `302` to the gateway short link by default
  (**redirect mode**: zero bandwidth through this box; clients follow it,
  ranges intact). Set `PROXY_MODE=pipe` to stream bytes through the server
  with Range forwarding instead (costs bandwidth, hides origins).
- **`HEAD`** exposes type + length for players that probe before playing.
- Write methods (`PUT/DELETE/MKCOL/…`) → `501`. Read-only by design.
- Unauthenticated requests → `401` whenever `DAV_USER` is set.

## Clients

Any WebDAV client: Solid/Cx File Explorer (Android), Finder → Connect to
Server (Mac), `rclone`/`davfs2` (Linux), mpv/VLC (direct file URLs).
Behind Caddy for public HTTPS + an extra basic-auth layer, same pattern as:

```caddy
handle /tb/* {
    basicauth { <user> <bcrypt-hash> }
    uri strip_prefix /tb
    reverse_proxy 127.0.0.1:8086
}
```

## Limits

- Playback depends on the gateway + TeraBox links (they expire; each `GET`
  uses a fresh short link, so expiry is invisible).
- Free-account TeraBox speeds apply upstream (~1.5–3MB/s per file).
- Large share listings are live API calls — first PROPFIND on a huge folder
  takes seconds; no local index (yet).
