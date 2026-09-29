# p2pfilesharing

Peer-to-peer file sharing in the browser. One token carries the room ID and
the encryption key for a whole share, so the two tabs connect directly and the
files never touch a server. The receiver cannot see what is in the share until
it has connected, and takes the files it wants one at a time.

## Run it

```bash
npm install
npm run dev
```

Open the printed URL. WebRTC needs a secure context, so use `localhost` for
development and HTTPS for anything deployed.

## How it works

The Sharing tab mints a single bech32m token. It is 54 bytes —
`roomIdLen(1) | roomId(20) | keyLen(1) | key(32)` — and 98 characters once
bech32m-encoded, including the `p2fs1` prefix. That is all it carries: a
20-character PeerJS room ID and a freshly generated AES-256-GCM key. No
filename, no size.

The Receiving tab decodes that token and connects straight to the sender. The
sender's first frame on the connection is an **encrypted manifest**: the same
key and the same AEAD, carrying the whole file list as JSON. It is a binary
frame, not a control frame, because control frames are sent in the clear and a
cleartext manifest would hand the whole file list to anyone watching the
connection. The receiver shows the list and picks files from it; there is no
"download all" and no folder picker, so each download gets its own destination
— a save dialog where the browser supports one, and an immediate browser
download where it does not.

Files are encrypted in 64 KiB chunks. A chunk's 12-byte nonce is 4 bytes of
big-endian file index at offset 0 and 8 bytes of big-endian chunk index at
offset 4, so within one connection no two chunks are encrypted under the same
nonce. The manifest occupies the reserved index `(0, 0)`; real files are
numbered from 1. A share carries at most 200 files, names are capped at 255
bytes each, and the whole list has to fit in 64 KiB.

Because the nonces are fixed by position, taking the same file twice repeats its
nonces under the same key. That is safe here, and always has been: the second
copy repeats the plaintext too, so it hands the peer nothing it could not
already decrypt. A file can therefore be re-downloaded freely, and a failed one
retried, on the same connection. See the frozen-file-set note under Security
notes for the one change that would break that.

The signalling server only ever sees two opaque peer IDs and connection
metadata for the handshake. It cannot see the filenames, the sizes, or a single
byte of file content — those travel inside the encrypted channel. When no direct
route exists, a TURN relay carries the traffic; it forwards encrypted packets
without being able to read them. A relay can see the two addresses and the
volume and timing of the traffic it forwards, so it knows the peers connected
and roughly how much was transferred, but not what.

Control frames are the exception. They are cleartext JSON, and the `offer`
frame that precedes each file's data carries that file's name and size. A
connected peer — and a relay carrying that frame — learns the name and the size
of every file it downloads. The file list itself stays inside the encrypted
manifest, so without the token nobody can enumerate what a share contains.

### The receiving flow

1. Open a share link, or paste a token or a link into the Receiving tab, and
   press Connect. Opening a link is enough: the app starts on the Receiving tab
   with the token already filled in and connects on its own.
2. The tab connects and waits. There is nothing to show yet — the file list
   arrives encrypted, so it only exists once the connection does.
3. The list appears, one row per file with its size and a Download button.
4. Download opens a save dialog, then the row shows progress, rate and
   estimated time remaining, and finally Saved.
5. Done sends a `finish`, closes the connection, and returns to the paste form
   with the token still in the box, so the same share can be reopened.

If the sender stops sharing or closes their tab, the receiver says so and
disables the remaining rows: there is nobody left to ask. That notice appears
whether or not a download is in flight, so an idle receiver does not sit on a
file list it can no longer use.

### Trust model

The share token is a bearer secret: anyone who has it can decrypt every file in
the share. Send it over a channel you trust, and treat possession of the token
as equivalent to possession of the files themselves. There is no second factor,
no server-side revocation, and no password.

The share link is the token in the **fragment** of this app's URL
(`https://host/#p2fs1...`). The fragment is never sent to the server, never
appears in access logs, and is not leaked through `Referer`. A query parameter
such as `?s=p2fs1...` would ride along with every request for the page and
every asset, so the link deliberately does not use one.

Tokens do not expire. A token stays valid until the sender closes its tab, and
until then anyone who has it can connect. An unused token is a live key waiting
to be used, so share it once and let it go rather than leaving it lying around.

One half of the token does leave the browser. The **key** never does: it stays
in the fragment and in page memory. The **room ID** is the broker's address for
you, and it is sent in the signalling query string by design, the way any
address is. Someone who can see the signalling traffic learns that two peers
were trying to meet, and nothing about what they are sending.

## Configuration

Defaults target the public PeerJS cloud broker and its public TURN relays, so
nothing needs configuring for development. All variables are read at build time.

### Share link host

| Variable | Default | Meaning |
|---|---|---|
| `VITE_APP_URL` | the current page's origin and path | Base URL used when building a share link |

Set this when the sender runs on `localhost` but the receiver does not, so the
generated link points somewhere a remote machine can open.

```bash
VITE_APP_URL=https://send.example npm run build
```

Without it the link is built from wherever the page is served, which is right
for any real deployment and wrong for local development. A value that is not a
parseable URL is ignored and the page's own URL is used instead.

### Broker

| Variable | Default | Meaning |
|---|---|---|
| `VITE_BROKER_HOST` | `0.peerjs.com` | Broker hostname |
| `VITE_BROKER_PORT` | `443` | Broker port; falls back to 443 if unparseable |
| `VITE_BROKER_PATH` | `/` | Broker WebSocket path |
| `VITE_BROKER_SECURE` | `true` | Set to `false` to use `ws://` instead of `wss://` |

`npm run signaling` starts a local broker on port 9000, fetched on demand by
`npx` and version-pinned rather than installed as a dependency: it is a
localhost-only developer tool that never ships to the browser, and the
published package hard-pins transitive dependencies with critical advisories.

**It does not work with this client.** The pinned `peerjs-server@0.2.9` has
its HTTP routes disabled and answers `/peerjs/id` with a 404. PeerJS gives the
side that initiates a connection an anonymous peer ID, allocated by asking the
broker for one, and that is the route the Receiving tab needs before it can
connect. It never gets an ID, so no transfer completes against a local broker.
The public broker serves the route, which is why both the defaults and the live
end-to-end tests use it.

### TURN relays

| Variable | Default | Meaning |
|---|---|---|
| `VITE_TURN_URL` | public PeerJS relays | Relay URL, e.g. `turn:turn.example.com:3478` |
| `VITE_TURN_USERNAME` | `peerjs` | Relay username |
| `VITE_TURN_CREDENTIAL` | `peerjsp` | Relay credential |

To use your own relay instead of the public ones, supply all three:

```bash
VITE_TURN_URL=turn:turn.example.com:3478 \
VITE_TURN_USERNAME=user \
VITE_TURN_CREDENTIAL=secret \
npm run dev
```

An incomplete override is ignored and the defaults are used instead. This is
deliberate: a TURN server without credentials is rejected outright by every
browser, so honouring a partial override would silently break transfers rather
than fall back. If you set only `VITE_TURN_URL`, the public relays stay in use.

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Development server |
| `npm run build` | Typecheck both tsconfigs, then build to `dist/` |
| `npm run preview` | Serve the built `dist/` locally |
| `npm test` | Unit and integration tests, no network needed |
| `npm run test:watch` | Tests in watch mode |
| `npm run typecheck` | TypeScript only |
| `npm run e2e` | Playwright tests; the networked ones need `E2E_LIVE=1` |
| `npm run signaling` | Local broker, but see the caveat above |
| `npm run deploy` | Build and publish to the `gh-pages` branch |

The networked end-to-end tests need the public broker, so they only run against
a network they can reach:

```bash
E2E_LIVE=1 npx playwright test
```

## Deploying

`npm run build` produces a static `dist/`. Any static host over HTTPS works:
GitHub Pages, Netlify, Vercel, Cloudflare Pages.

Since the broker, TURN and app URL variables are baked in at build time, set
them in your host's build environment rather than at runtime.

### GitHub Pages

```bash
npm run deploy
```

That typechecks, builds, and force-pushes `dist/` to the `gh-pages` branch,
replacing whatever was there. Set **Settings → Pages → Deploy from a branch**
to `gh-pages` / `(root)`.

The base path is the part that usually breaks a project site, since it is served
from `https://<user>.github.io/<repo>/` rather than the root. The script works it
out from the origin remote, and honours `VITE_BASE` if you need to override it:

```bash
VITE_BASE=/p2pfilesharing/ npm run deploy
```

A repository named `<user>.github.io` is a user site and is served from the
root, so the base becomes `/` and needs no override.

Set `VITE_APP_URL` too when the app lives somewhere other than where the sender
is running it, so the share links it generates point at the deployed site.

## Security notes

- Tokens are held in component state only. They are never written to
  `localStorage` or `sessionStorage` and never logged. The end-to-end suite
  asserts that after a real two-file transfer, and also scans every request,
  request body and WebSocket the page opened for the token.
- A share link is `<app-url>#<token>`, where the token starts with `p2fs1`. The
  Receiving tab accepts a full link or a bare token, opens by itself when the
  page loads with one in the fragment, and ignores a token that arrives in a
  query parameter.
- The file list travels encrypted, so a peer learns what a share contains only
  by decrypting the manifest. Each file's name and size are then repeated in
  the clear in the `offer` frame that precedes its data, so a connected peer
  and a relay carrying that frame see every file that peer downloads.
- Filenames come from the manifest and are attacker-controlled as far as the
  receiver is concerned. Before one is used as a save target it is stripped of
  path components, control characters, and Windows-reserved device names.
- Each chunk carries its own GCM tag, so a corrupted or tampered chunk fails
  loudly instead of writing bad data to disk.
- Nonces are derived from a frame's position in the share, not from the
  connection, so the encrypted manifest and each file's chunks are identical
  for every receiver: two receivers on the same share are each served the same
  files under the same
  nonces and the same key. Colluding receivers can confirm their copies are
  byte-identical; nothing beyond that follows from the reuse.
- That reuse is only safe because **the file set is frozen for the life of a
  share**. Every time a `(fileIndex, chunkIndex)` pair repeats — across
  connections, or on a re-select within one — the plaintext repeats with it, so
  the reuse only ever hands a peer something it could already decrypt. Adding a
  file to a share after its token is minted, without minting a new key, would
  break the assumption: the same nonce would then encrypt two different
  plaintexts, which leaks their keystream XOR. Such a change has to remint the
  token, and there is nothing in the protocol that would notice if it did not.
- The encryption covers the two endpoints on the wire, not the machine at
  either end. The receiving browser decrypts and writes plaintext to a path the
  user picks; in a browser without the File System Access API the whole file is
  buffered in page memory first. Full-disk encryption, swap, browser
  extensions, and backups of that machine are all outside what this app can
  control. The sender's page holds the plaintext of every file it picked.
