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

The Sharing tab mints a single bech32m token. It is 55 bytes —
`roomIdLen(1) | roomId(20) | keyLen(1) | key(32) | relay(1)` — and 99 characters
once bech32m-encoded, including the `p2fs1` prefix. That is all it carries: a
20-character PeerJS room ID, a freshly generated AES-256-GCM key, and the index
of the relay the sender designated. No filename, no size.

That last byte names which relay from a fixed server table the sender chose, so a
receiver on a different build still gathers candidates from the same server — the
build difference shows up later, when the two peers exchange frames, not at
gathering time. A 54-byte token minted before the field existed still decodes, and
the receiver falls back to its own default. See [Choosing a connection
server](#choosing-a-connection-server).

The relay byte is the only part of a share that keeps its meaning across a
deploy. The key and the room code are build-independent, but the frames two
peers exchange are not, so a share link only works between peers running the
same build. See the wire-format note under Security notes.

The Receiving tab decodes that token and connects straight to the sender. The
sender's first frame on the connection is an **encrypted manifest**: the same
key and the same AEAD, carrying the whole file list as JSON. It is a binary
frame, not a control frame, because control frames are sent in the clear and a
cleartext manifest would hand the whole file list to anyone watching the
connection. The receiver shows the list and picks files from it; there is no
"download all" and no folder picker, so each download is saved on its own —
through the browser's download by default, or through a save dialog where the
browser supports one and `VITE_DOWNLOAD_MODE=picker` asks for it.

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

The signalling server sees two opaque peer IDs and connection metadata for the
handshake. It cannot learn a filename or read a single byte of file content —
those are sealed. When no direct route exists, a TURN relay carries the traffic;
it forwards encrypted packets without being able to open them. A relay can see
the two addresses and the volume and timing of the traffic it forwards, so it
knows the peers connected and exactly how much was transferred, and it can stall
or drop the connection — but not what the files are or what is in them.

That last sentence is narrower than it looks, because a file's **size** is not
one of the things a relay is kept from. Dropping `size` from the `offer` moved it
out of a labelled field and into a derivable one rather than removing it. Every
chunk is its own data channel message, and a sealed message is its plaintext plus
a 16-byte tag, so a relay that forwards the frames can count them and add up
their lengths and subtract 16 bytes per message, and come away with each file's
exact byte size without decrypting anything. A 300 KB file goes out as five
messages — four full 64 KiB chunks and a 45,056-byte remainder — and the tag
arithmetic lands on 307,200 without anyone reading a byte of the plaintext. The
frame count gives how many files are being taken, and the cleartext `select`
frames say which ones, by their position in the manifest. So the honest limit is
that a relay learns the *shape* of a share — how many files, how large each one,
which were taken — and neither a name nor a byte of content. The end-to-end suite
measures the size recovery rather than asserting it in prose.

That the files are unreadable is a property of the token key, not of the
transport. The fingerprints the two ends use to bring up the encrypted channel
are exchanged through the signalling broker, so the transport is not the
boundary: a hostile broker can see the handshake, terminate the channel on both
sides, and read the cleartext control frames that follow. None of that reaches
the file bytes, which stay sealed under a key the broker never sees. What
survives a broker that reads everything is the key, not the channel.

Control frames are the exception. They are cleartext JSON, so what they carry is
what a connected peer or a relay can read. The `offer` frame that precedes each
file's data now carries only the chunk size; it used to carry that file's name
and size, which handed a connected peer — and a relay carrying the frame — the
name and the size of every file it downloaded. That is gone. The manifest is
   sealed, and so is each chunk, under a binding that ties it to its file index and
   total size, so no name and no labelled size goes out in the clear. A size is
   still recoverable by adding up frame lengths, as above. An `offer`
that still carries a name or a size is refused outright rather than parsed and
dropped, because those fields would have gone over the wire whatever this build
did with them afterwards. The file list itself still travels inside the sealed
manifest, so without the token nobody can enumerate what a share contains.

### The receiving flow

1. Open a share link, or paste a token or a link into the Receiving tab, and
   press Connect. Opening a link is enough: the app starts on the Receiving tab
   with the token already filled in and connects on its own.
2. The tab connects and waits — *Connecting and asking for the file list...* —
   until the list arrives. There is nothing to show before that, because the
   file list is encrypted and only exists once the connection does.
3. The list appears: *N files are on offer. Queue the ones you want and they will
   be taken one at a time.* Each row carries the name, the size, and a three-dot
   button — *More actions for `name`* — whose menu has a single item, **Download**.
4. Choosing **Download** queues the file rather than starting it straight away, so
   several files can be lined up in one go. A queued row reads *Queued*, and
   offers no menu of its own until it comes back around.
5. A **Queue** panel sits below the list for the whole time the list is up, empty
   or not, because a panel that only appeared once something was queued would
   make the queue hard to find. It reads `Queue (0 files)` and *Nothing queued
   yet.* to begin with, and **Clear all** is disabled until there is something to
   clear. Each entry shows the name, the size, and where that file is: *Queued*,
   *Downloading*, or *Failed*. The file being fetched shows live progress in its
   own entry — percent, bytes of total, rate, and time left — which is the same
   text the row in the list shows. Every entry has a × button, *Cancel `name`*,
   that takes that one file back out of the queue and returns its row to taking
   orders; the × on the file in flight is disabled, because that file has already
   left the queue. **Clear all** empties the queue around the file in flight
   rather than interrupting it.
6. Downloads run one at a time, because the protocol serves one `select` at a
   time. Each finished file is saved — through a save dialog, or straight to the
   browser's downloads folder — and the status line says *Saved to disk.* The row
   itself leaves the queue and carries no state label, so that line is the only
   sign a file is finished.
7. **Done** sends a `finish`, closes the connection, and returns to the paste
   form with the token still in the box, so the same share can be reopened. It is
   disabled while anything is queued or downloading, so a share cannot be closed
   out from under a transfer that was asked for.

If the sender stops sharing or closes their tab, the receiver says so and
disables the remaining rows: there is nobody left to ask. That notice appears
whether or not a download is in flight, so an idle receiver does not sit on a
file list it can no longer use. The same disconnection empties the queue and
returns its rows to the list, because nothing queued can run once there is no
connection left to run it on.

The Sending tab is the other end of the same story. Every connected receiver is
numbered, and each file it takes gets a row with a progress bar. When a receiver
leaves, its rows are removed, the connected-receiver count drops so that with
nobody left connected the tab reads *Waiting for a receiver...* again, and the
status line names the departure — *Receiver 1 left.*, or *The connection to
Receiver 1 failed.* — provided the line was still about that receiver. A receiver
that was still browsing the list had no row to remove, and if the status line has
since moved on to something else, a copied token say, its departure is silent.

One gap is named here rather than papered over. A receiver whose tab navigates
away is caught, because the data channel closes with it. A receiver whose browser
crashes, or whose network drops, is not: `PeerChannel` only listens for the data
connection's `close` and `error` events, and PeerJS acts only on an ICE state of
`failed` or `closed` and ignores `disconnected`, so the sender's row and the
receiver count stay on screen. Measured in the end-to-end suite, the connection
reports `disconnected` at about 25 seconds and `closed` at about 65, and the row
was still there at about 265. The suite pins that as a test marked `test.fail()`,
so when a liveness check does land, the run reports a test that was expected to
fail and passed, which is the prompt to delete the marker.

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

A complete override swaps the relay and leaves address discovery alone, so the
table's STUN server is still used and a direct route is still attempted first.
The Sending tab's **Connection servers** panel is not shown at all in that case —
see below. The relay byte still goes into the token, but a receiver running a
build with the same override ignores it in the same way.

### Choosing a connection server

A direct connection is always tried first. The Sending tab lists the servers
that help when there is not one, in a collapsed **Connection servers** panel:
Google's public STUN addresses, which discover a public address but cannot carry
traffic, and the two PeerJS community relays, which can — the relays the app has
always used. The Google entry now names five addresses, `stun.l.google.com`
through `stun4.l.google.com`, where it named two. They are free, identical in
kind, and there is no reason to enumerate fewer of them, but the default config
is wider than it used to be.

One relay is designated, and only that index reaches the share link. The
designated relay cannot be switched off, because `iceConfigFor` always puts one
in the config and a share with no relay cannot cross a hard NAT; every other
entry is optional, and a STUN entry cannot be designated at all since it cannot
relay. Nothing else you switch off here reaches the receiver: it has no picker,
and unless the receiving build names its own relay it gathers from all three
servers by default plus the one the token names, so your choice only changes the
candidates your browser offers. The choice is
remembered in your browser, and the panel says so whenever the remembered choice
is not the default, so a deviation is never something only the config knows
about. **Reset to default** puts it back.

A build that sets all three `VITE_TURN_*` variables shows no panel at all. The
override replaces the relay and the picker would be a control that silently did
nothing, so instead the panel says which relay the token will name and stops
there.

Every entry here is a public server whose credentials are already public,
because a share token names a relay by an index into a fixed table and the two
peers may be running different builds. A relay needing a secret of its own could
not be named in a token at all. That rules out Open Relay, whose port-443 entries
would otherwise be the answer for a network that blocks 3478: it has no static
username and password, only a shared secret that the browser would have to use
to derive per-session credentials, or an account API key a static site cannot
hold. So a user behind a proxy that blocks 3478 still has no relay to pick, and
that gap is recorded here rather than papered over.

The choice is a build-independent index into a fixed table, not a URL, so a
crafted link cannot aim your browser at somebody else's relay: a byte can only
name a server this app already ships.

Google publishes no public TURN server, so its entries are STUN only. Every relay
here is somebody else's server: it sees the two addresses, the volume, and the
timing of what it forwards, and it can stall or drop the connection. It cannot
read the files, which are sealed with a key that only exists inside the token.
Choosing a different relay changes who can see that metadata, never what they
can read.

### How a received file is saved

| Variable | Default | Meaning |
|---|---|---|
| `VITE_DOWNLOAD_MODE` | `browser` | Set to `picker` to save through a save dialog instead of the browser's own download |

By default the receiver writes each file through the browser's own download, so
it lands in the browser's usual downloads folder with no dialog. That path
buffers the whole file in page memory first, and the UI says so for anything
over 512 MB.

Setting the mode to `picker` opens a save dialog per file and streams straight to
the chosen path instead, so file size stops being a constraint:

```bash
VITE_DOWNLOAD_MODE=picker npm run build
```

The default is the browser download because it cannot be rejected the way a
save dialog's destination can. Windows in particular refuses a save-dialog write
with `NoModificationAllowedError` when the target is read-only, held by a synced
folder such as OneDrive or Dropbox, or locked by another program; only the exact
value `picker` selects the dialog, and any other value, including a typo, keeps
the browser download.

This is set per build, not per user, so switching modes means rebuilding. The
mode applies to the whole app, so a receiver who needs the save dialog has to be
sent a build that opens one.

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
  by decrypting the manifest. The `offer` frame that precedes each file's data
  carries only the chunk size, and it no longer names anything, so a connected
  peer and a relay carrying that frame learn no name and no size *field*. The
  size is still recoverable from what follows, because each chunk is its own
  message of `plaintext + 16` bytes — see the limit stated above. An `offer` that
  still carries a name or a size is refused outright, because those fields would
  have gone over the wire whether or not this build read them.
- Each chunk is sealed under a binding that fixes its file's index and total
  size, which both sides derive independently and never transmit. A sender that
  streams one file's bytes under another's index, or seals a file under a size
  other than the manifest declared, fails authentication on the first chunk
  instead of quietly writing the wrong content — unless it delivers *more* than
  the manifest declared, in which case the declared-length check trips first and
  nothing is decrypted at all.
- What the binding does **not** cover is the file's name. A receiver cannot tell
  from the cryptography that the bytes under index 3 are the ones the sender
  filed as `quarterly.pdf`, because nothing that names a file enters the frame
  at all. So a sender that labels its own files inaccurately is not caught, and
  that is the one substitution the old cleartext check would have noticed. Both
  peers already hold the name in the manifest, so binding it was considered, but
  the wire format is frozen and this was decided against changing it. It is
  written down here because a limit nobody can see is a limit a reader will
  assume away.
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
- **The wire format is not negotiated, so a share only works between peers on
  the same build.** It has already changed once, and a stale sender now fails
  early and legibly. A share's first frame is its manifest, which is decrypted
  before any control frame is parsed, so that is where a build that sealed its
  frames without a binding is caught: there the receiver cannot tell a wrong key
  or a tampered frame apart from a stale one, so it reports the integrity failure
  and mentions the reload as a possibility rather than a diagnosis: *"Integrity
  check failed. If the sender has had this page open for a while, they may need to
  reload it."* An `offer` that still carries the file's name is refused outright
  before it is parsed, and because a name in an `offer` is diagnostic on its own
  the receiver can name the version: *"This sender is running a different version.
  If they have had this page open for a while, they should reload it."* That
  branch is a backstop — a stale sender trips the manifest first and never gets as
  far as an `offer`. Both fail before a byte is written. The likeliest way to hit
  either is a sender who left the page open across a deploy. Nothing falls back to
  the old format: this is a deliberate cutover, and keeping a second wire format
  correct is a worse answer than asking a stale tab to reload.
- The encryption covers the two endpoints on the wire, not the machine at
  either end. The receiving browser decrypts and writes plaintext to disk — to
  the browser's downloads folder by default, or to a path the user picks under
  `VITE_DOWNLOAD_MODE=picker` — and in the default mode the whole file is
  buffered in page memory first. Full-disk encryption, swap, browser
  extensions, and backups of that machine are all outside what this app can
  control. The sender's page holds the plaintext of every file it picked.
