/// <reference types="node" />
import { bech32m } from 'bech32';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { TAG_BYTES } from '../src/crypto/chunks';

const LIVE = process.env['E2E_LIVE'] === '1';
const SKIP_LIVE = 'set E2E_LIVE=1 to run the networked test';

const FILE_A = 'e2e-share-a.bin';
const FILE_A_SEED = 0x2f6e2b1;
const FILE_A_BYTES = 300 * 1024;

const FILE_B = 'e2e-share-b.bin';
const FILE_B_SEED = 0x13a5f27;
const FILE_B_BYTES = 150 * 1024;

// The file held in flight while a second file is queued behind it, for the two
// tests that need the queue to visibly hold two files at once. FILE_A is no
// use for that: 300 KB crosses a DataChannel between peers on one machine in
// well under 100ms, so it is always saved before the second Download lands.
// Measured in this environment, 1MB drains in ~80ms and 4MB takes ~2.8s, where
// the channel's 1MB high water mark makes the sender wait instead of bursting —
// so 4MB is the smallest size on the list that buys a window worth asserting in.
const FILE_HOLD = 'e2e-share-hold.bin';
const FILE_HOLD_SEED = 0x3c9a11d;
const FILE_HOLD_BYTES = 4 * 1024 * 1024;

const TOKEN_PATTERN = /^p2fs1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]+$/;

// The only file-level number the app's chunking is built from, spelled out here
// rather than imported from src/crypto/chunks.ts, for the reason TOKEN_LENGTH is:
// the wire test below asserts on the frames a peer actually receives, so its idea
// of a chunk has to be an independent statement rather than the constant restated
// by the code under test.
const CHUNK_SIZE = 65536;

// roomIdLen(1) | roomId(20) | keyLen(1) | key(32) | relay(1) = 55 bytes, which
// bech32m packs into 88 data characters plus a 6 character checksum, behind the
// "p2fs1" human readable part: 99 characters, every time. A token minted before
// the relay byte existed is 54 bytes and 98 characters, and is still a valid
// link; `tokenWithRelay` below is how the suite forges one.
const TOKEN_LENGTH = 99;
const TOKEN_DATA_CHARS = 88;

// The ICE server table, by the name the picker shows and in table order, which
// is also the index order a share token's relay byte names. Spelled out here
// rather than imported from the app: TOKEN_LENGTH above is a deliberate
// independent statement of the encoder's output, and a relay index is only
// meaningful while the table's order and names are pinned the same way. A
// reordering would silently repoint every token already shared, so it has to
// make this file red rather than pass.
const SERVER_NAMES = ['Google STUN', 'PeerJS EU', 'PeerJS US'] as const;
const STUN_INDEX = 0;
const EU_RELAY_INDEX = 1;
const US_RELAY_INDEX = 2;

// `localStorage` is the only place a hand-edited selection can be exercised:
// the picker reads it at mount, and vitest runs in node where there is no
// localStorage, so nothing else covers what a stored value is worth.
const ICE_STORAGE_KEY = 'p2fs.ice';

// The table's own URLs, for the one assertion that has to read the config a
// browser was actually given. The STUN entry is listed as all five of its URLs
// because a config that named only some of them would be a different claim.
const ALL_STUN_URLS = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:stun2.l.google.com:19302',
  'stun:stun3.l.google.com:19302',
  'stun:stun4.l.google.com:19302',
];
const BOTH_RELAY_URLS = ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'];

const REJECT_BUDGET_MS = 5_000;

// How long the abruptly-dying receiver's test gives the sender to notice. This
// is the app's budget, not the app's observed behaviour: PeerJS reports
// iceConnectionState "disconnected" at ~25s and "closed" at ~65s in this
// environment, and PeerChannel forwards neither, so today the row outlives any
// value here. It is one second under the suite's 45s expect timeout so a run
// with the default budget reports this assertion rather than a bare timeout.
const ABRUPT_CLOSE_BUDGET_MS = 44_000;

// How long the mid-start test waits for the broker socket to appear. The public
// broker answers in well under a second in practice; this is the ceiling before
// the test declares the round trip never started.
const BROKER_SOCKET_MS = 15_000;

// Token-shaped but not a real token: the checksum does not verify, so the
// Receiving tab reports it as unreadable while still rendering the field.
const FAKE_TOKEN = `p2fs1${'q'.repeat(TOKEN_DATA_CHARS)}`;

export interface E2EFile {
  name: string;
  path: string;
  bytes: Buffer;
}

// Every fixture directory is registered here and removed in the afterEach below,
// so a run does not leave a p2fs-e2e-* directory behind in the OS temp
// directory whether it passed or failed.
const fixtureDirs: string[] = [];

test.afterEach(async () => {
  const dirs = fixtureDirs.splice(0, fixtureDirs.length);
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

export interface DiskWrite {
  suggestedName: string | null;
  bytes: number;
  closed: boolean;
  aborted: boolean;
  base64: string;
}

export interface E2EDiskProbe {
  calls: number;
  files: { suggestedName: string | null; bytes: number; closed: boolean; aborted: boolean; read(): string }[];
}

declare global {
  interface Window {
    __e2eDisk?: E2EDiskProbe;
    __e2eSockets?: string[];
    __e2eRowProgress?: string[];
    __e2eAlerts?: string[];
    __e2eIce?: string[][];
    __e2eFrames?: E2EFrames;
  }
}

export interface E2EFrames {
  // What the page handed to a data channel as a string: the control frames,
  // which is everything on this connection a relay reads in the clear.
  clear: string[];
  // The byte length of every sealed frame that went out, so a capture that saw
  // only the cleartext half is distinguishable from one that saw all of it.
  sealed: number[];
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// The receiver keeps exactly one role="status" live region at a time: the
// "Saved to disk." line while the file list is up, and the closing status once
// Done has torn the list down. So this locator is safe in both phases, where
// the old p.ok-only helper was not.
function liveRegion(page: Page): Locator {
  return page.getByRole('status');
}

// The picker's summary, by element rather than by text: the sentence is also in
// the <details> it opens, so a getByText for it matches two elements and trips
// strict mode. The picker is collapsed on arrival, so every assertion about its
// controls has to open it first - the controls are in the DOM but not visible.
async function openPicker(page: Page): Promise<void> {
  const summary = page.locator('details.advanced > summary');
  await expect(summary).toHaveText('Connection servers');
  await summary.click();
  await expect(page.getByLabel(SERVER_NAMES[STUN_INDEX], { exact: true })).toBeVisible();
}

// A server's checkbox and its relay radio are not in a common container, so
// nothing here scopes to a per-server row and then reaches inside one. Each
// checkbox is found by its own label, exact because `Designate Google STUN as
// the relay` also contains `Google STUN`, and each radio by the accessible name
// the app gives it.
function serverCheckbox(page: Page, index: number): Locator {
  return page.getByLabel(SERVER_NAMES[index] as string, { exact: true });
}

function relayRadio(page: Page, index: number): Locator {
  return page.getByRole('radio', { name: `Designate ${SERVER_NAMES[index] as string} as the relay` });
}

interface E2ESelection {
  enabled: number[];
  relay: number | null;
}

// What the picker is actually showing: the checked boxes as indices, and the one
// checked radio. An unchecked radio is never `relay: null` in a real page, so a
// count other than one is a failure rather than a reading to report.
async function selectionIn(page: Page): Promise<E2ESelection> {
  const enabled: number[] = [];
  for (const [index] of SERVER_NAMES.entries()) {
    if (await serverCheckbox(page, index).isChecked()) enabled.push(index);
  }
  const designated: number[] = [];
  for (const [index] of SERVER_NAMES.entries()) {
    if (await relayRadio(page, index).isChecked()) designated.push(index);
  }
  if (designated.length !== 1) {
    throw new Error(`the picker designated ${designated.length} relays: ${designated.join(', ')}`);
  }
  return { enabled, relay: designated[0] as number };
}

// The line naming a deviation from the default, and the button that undoes it.
// Both are addressed by element for the reason the summary is: the row around
// them contains their text, so a text locator matches it too.
function deviationLine(page: Page): Locator {
  return page.locator('span.muted', { hasText: 'Not the default:' });
}

function resetButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Reset to default' });
}

function noDiscoveryWarning(page: Page): Locator {
  return page.locator('p.muted.small', { hasText: 'No address-lookup server is enabled' });
}

// What the picker chose, as stored. Read back rather than assumed from the
// controls, because the point of the check is that the choice is persisted and
// not merely drawn.
async function storedSelection(page: Page): Promise<E2ESelection | null> {
  const raw = await page.evaluate((key: string) => localStorage.getItem(key), ICE_STORAGE_KEY);
  if (raw === null) return null;
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== 'object') return null;
  const fields = parsed as { enabled?: unknown; relay?: unknown };
  return {
    enabled: Array.isArray(fields.enabled) ? (fields.enabled as number[]) : [],
    relay: typeof fields.relay === 'number' ? fields.relay : null,
  };
}

// Installed before the first navigation, because the selection is read once at
// mount and nothing after that would see the seeded value. `null` leaves the key
// absent, which is a first run rather than a bad value.
async function seedIceSelection(page: Page, stored: string | null): Promise<void> {
  await page.addInitScript(
    (seed: { key: string; raw: string | null }): void => {
      if (seed.raw === null) localStorage.removeItem(seed.key);
      else localStorage.setItem(seed.key, seed.raw);
    },
    { key: ICE_STORAGE_KEY, raw: stored },
  );
}

// Records the iceServers every RTCPeerConnection is constructed with, which is
// the only way to see what a browser is told to gather from - the app's own
// config is built inside PeerJS and never surfaces in the DOM.
//
// PeerJS also constructs one RTCPeerConnection of its own when it loads, to
// probe browser support, with its hardcoded default: a single STUN URL and both
// relays in one entry. No assertion below may be satisfiable by that record,
// which is why they name all five of the table's STUN URLs rather than "a STUN
// URL" - the probe's one would pass for it.
async function spyOnPeerConnections(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const configs: string[][] = [];
    window.__e2eIce = configs;
    const Original = window.RTCPeerConnection;
    (window as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection = new Proxy(Original, {
      construct: (target, args: unknown[]) => {
        const config = (args[0] ?? {}) as { iceServers?: RTCIceServer[] };
        const urls: string[] = [];
        for (const server of config.iceServers ?? []) {
          const list = Array.isArray(server.urls) ? server.urls : [server.urls];
          for (const url of list) urls.push(String(url));
        }
        configs.push([...urls].sort());
        return Reflect.construct(target, args);
      },
    });
  });
}

// Sorted, so an assertion states which servers were gathered from rather than
// which order `iceConfigFor` happened to compose them in.
async function iceConfigs(page: Page): Promise<string[][]> {
  return page.evaluate(() => {
    if (window.__e2eIce === undefined) {
      throw new Error('the RTCPeerConnection trace was never installed');
    }
    return window.__e2eIce;
  });
}

// What the page actually put on the wire, captured at the data channel: every
// payload the page hands to RTCDataChannel#send, split by whether it was a
// string or sealed bytes.
//
// Why the channel and not RTCPeerConnection: an RTCPeerConnection has no send of
// its own. PeerJS creates the channel and then writes each frame to it in
// DataConnection#_trySend, so the last point at which a frame is still
// recognisable as a frame - a JSON string, or ciphertext - is that call. With
// `serialization: 'raw'` (src/transport/peerjs.ts:240) PeerJS encodes nothing
// itself, so a string arrives here verbatim and is what a relay reads off the
// connection in the clear.
//
// Both ways a channel reaches a peer are covered, because which one this page is
// depends on which side of the connection it is, and the sender is the side that
// never calls createDataChannel: it waits on peer.on('connection') for a receiver
// to dial in, so PeerJS answers the connection and hands the channel over on
// `ondatachannel`. Wrapping the object rather than the event means the ordering
// of the two listeners cannot matter - PeerJS stores the same channel this
// wraps, so `send` is already wrapped by the time it looks.
//
// The constructor Proxy is the same mechanism spyOnPeerConnections above already
// depends on: PeerJS names the bare global in `new RTCPeerConnection(...)`, so it
// looks the name up at call time rather than caching the constructor, and a
// wrapper installed by addInitScript before the first script is the object it
// constructs. Wrapping what it hands back, rather than the constructor, is the
// whole reason this differs from that one.
async function captureFrames(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const probe: E2EFrames = { clear: [], sealed: [] };
    window.__e2eFrames = probe;
    const wrap = (channel: RTCDataChannel): void => {
      // `send` is overloaded, so the bound original is retyped rather than called
      // with one of the overloads' narrower unions; the wrapper below narrows it
      // again for the recording.
      const send = channel.send.bind(channel) as (data: unknown) => void;
      channel.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView): void => {
        if (typeof data === 'string') probe.clear.push(data);
        else if (data instanceof ArrayBuffer) probe.sealed.push(data.byteLength);
        send(data);
      };
    };
    const Original = window.RTCPeerConnection;
    (window as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection = new Proxy(Original, {
      construct: (target, args: unknown[]) => {
        const pc = Reflect.construct(target, args) as RTCPeerConnection;
        // The originating side, where PeerJS dials out.
        const open = pc.createDataChannel.bind(pc);
        pc.createDataChannel = ((
          ...channelArgs: Parameters<RTCPeerConnection['createDataChannel']>
        ): RTCDataChannel => {
          const channel = open(...channelArgs);
          wrap(channel);
          return channel;
        }) as RTCPeerConnection['createDataChannel'];
        // The answering side, which is the sender's own role here. PeerJS assigns
        // `ondatachannel` on the same instance after this construct returns, so
        // this is a listener alongside it rather than a replacement for it.
        pc.addEventListener('datachannel', (event: RTCDataChannelEvent) => wrap(event.channel));
        return pc;
      },
    });
  });
}

// Throws rather than reporting an empty capture: a green "no frame carries the
// filename" over a list that never filled is the failure this test exists to
// rule out, so the read has to make it impossible to reach the assertions.
async function framesSentBy(page: Page): Promise<E2EFrames> {
  return page.evaluate(() => {
    const probe = window.__e2eFrames;
    if (probe === undefined) throw new Error('the data channel capture was never installed');
    return { clear: [...probe.clear], sealed: [...probe.sealed] };
  });
}

function makePayload(seed: number, size: number): Buffer {
  const buffer = Buffer.allocUnsafe(size);
  let state = seed >>> 0;
  for (let i = 0; i < size; i += 1) {
    state ^= (state << 13) >>> 0;
    state ^= state >>> 17;
    state ^= (state << 5) >>> 0;
    state >>>= 0;
    buffer[i] = state & 0xff;
  }
  return buffer;
}

function roomIdOf(token: string): string {
  const { words } = bech32m.decode(token, 1000);
  const bytes = new Uint8Array(bech32m.fromWords(words));
  return new TextDecoder().decode(bytes.subarray(1, 1 + (bytes[0] as number)));
}

function truncatedToken(): string {
  const encoder = new TextEncoder();
  const roomId = encoder.encode('A1b2C3d4E5f6G7h8I9j0');
  const payload = Buffer.concat([
    Buffer.from([roomId.length]),
    Buffer.from(roomId),
    Buffer.from([32]),
    Buffer.alloc(16, 7),
  ]);
  return bech32m.encode('p2fs', bech32m.toWords(payload), 1000);
}

// The relay byte a token carries, or null for the 54-byte link a sender minted
// before the byte existed. Reads the payload rather than counting characters,
// because the rule it applies is the codec's own, and the codec's is stated in
// bytes.
function relayOf(token: string): number | null {
  const { words } = bech32m.decode(token, 1000);
  const bytes = new Uint8Array(bech32m.fromWords(words));
  return bytes.length === 55 ? (bytes[54] as number) : null;
}

// Re-encodes a real token with a different relay byte, keeping its room code and
// its key, so the result still points at a sender that is actually hosting. That
// is the whole point: a forged token is only meaningful to a receiver, and a
// receiver can only be shown one that would have come from a real sender.
//
// `null` drops the byte, which is the legacy 54-byte layout. Note that index 0
// is a legal value here and the codec does not check it against the table, so
// this is also how a token naming Google STUN - an entry that cannot relay - is
// built.
function tokenWithRelay(token: string, relay: number | null): string {
  const { words } = bech32m.decode(token, 1000);
  const head = Buffer.from(bech32m.fromWords(words)).subarray(0, 54);
  const payload = relay === null ? head : Buffer.concat([head, Buffer.from([relay])]);
  return bech32m.encode('p2fs', bech32m.toWords(payload), 1000);
}

async function trackPageErrors(page: Page, label: string, sink: string[]): Promise<void> {
  page.on('pageerror', (error: Error) => sink.push(`${label}: ${error.message}`));
}

async function makeFile(name: string, seed: number, size: number): Promise<E2EFile> {
  const dir = await mkdtemp(join(tmpdir(), 'p2fs-e2e-'));
  fixtureDirs.push(dir);
  const path = join(dir, name);
  const bytes = makePayload(seed, size);
  await writeFile(path, bytes);
  return { name, path, bytes };
}

async function startSharing(page: Page, files: readonly E2EFile[]): Promise<string> {
  await page.goto('/');
  await page.getByLabel('Choose files to share').setInputFiles(files.map((file) => file.path));
  for (const file of files) {
    await expect(page.locator('li.file-row').filter({ hasText: file.name })).toHaveCount(1);
  }
  const create = page.getByRole('button', { name: 'Create share token' });
  await expect(create).toBeVisible();
  await create.click();
  const field = page.getByLabel('Share token');
  await expect(field).toHaveValue(TOKEN_PATTERN);
  const token = await field.inputValue();
  expect(token.length, 'share token length').toBe(TOKEN_LENGTH);
  return token;
}

// Reads the link the way a user would: the sender's own Copy link button, and
// the clipboard it wrote. Nothing here hand-assembles a URL.
async function readShareLink(page: Page, token: string): Promise<string> {
  await page.getByRole('button', { name: 'Copy link' }).click();
  await expect(liveRegion(page)).toContainText('Link copied to the clipboard.');
  await page.bringToFront();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  const url = new URL(link);
  expect(url.hash, 'the link carries the token in the fragment').toBe(`#${token}`);
  expect(url.search, 'the link carries nothing in the query string').toBe('');
  return link;
}

// The share link's origin is chosen by buildShareLink, which honours
// VITE_APP_URL. A developer's own local .env can set VITE_APP_URL, which would
// build links to an origin the suite does not serve, and the receiver's
// page.goto would leave the Playwright baseURL and fail on a navigation error
// that looks like an app bug. Skip with a named reason instead: an honest skip,
// not a red test.
function requireSameOriginLink(page: Page, link: string): void {
  const built = new URL(link).origin;
  const here = new URL(page.url()).origin;
  const reason = [
    `the app is built with VITE_APP_URL=${built}, so the share link points`,
    `off-origin from the suite's ${here}; unset VITE_APP_URL to run this test`,
  ].join(' ');
  test.skip(built !== here, reason);
}

// The network counterpart of leakReport. The fragment keeps the token out of
// the address bar's request line, but the moment the receiver decodes it the
// token is a string in memory, and from there it could reach any code path in
// the page. The app's central claim is that it never does, so this watches
// every request and every WebSocket the page opens over a real connection, not
// just the URL of a link nobody clicked.
//
// WebSockets are recorded too, and not defensively: a WebSocket handshake is
// not reported as a request (verified against this app's own broker URL), and
// the PeerJS signalling URL is wss://0.peerjs.com/peerjs?key=...&id=... — the
// room id goes in that query string by design, so a future change that put the
// token there would be invisible to a request-only listener.
//
// The room id is deliberately not searched for: it is in the signalling query
// string on purpose, and it is the token, which carries the key, that must
// stay off the wire. Returns fixed strings, never the URL or the token.
async function wireLeakReport(
  wire: readonly string[],
  bodies: readonly string[],
  token: string,
): Promise<string[]> {
  const seen: string[] = [];
  for (const line of [...wire, ...bodies]) {
    if (line.includes(token)) seen.push('a request the page opened contains the token');
  }
  return seen;
}

// Installed before the first navigation so nothing is missed. The page.on
// pattern is the same one the corrupted-token test already uses.
function traceWire(page: Page): { wire: string[]; bodies: string[] } {
  const wire: string[] = [];
  const bodies: string[] = [];
  page.on('request', (request) => {
    wire.push(request.url());
    const body = request.postData();
    if (body !== null) bodies.push(body);
  });
  page.on('websocket', (socket) => wire.push(socket.url()));
  return { wire, bodies };
}

// Finding 6: Copy token is in the contract, and a regression that swapped the
// button's argument — copy(token) for copy(link) — would be invisible while
// only Copy link is driven. Asserted on the clipboard, and against both the
// ways it could go wrong: the bare token, and never a URL.
async function readCopiedToken(page: Page, token: string): Promise<string> {
  await page.getByRole('button', { name: 'Copy token' }).click();
  await expect(liveRegion(page)).toContainText('Token copied to the clipboard.');
  await page.bringToFront();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied, 'Copy token writes the bare token').toBe(token);
  expect(copied, 'Copy token writes no URL').not.toMatch(/^https?:/);
  expect(copied.includes('#'), 'Copy token writes no fragment').toBe(false);
  return copied;
}

async function connectFromLink(page: Page, link: string): Promise<void> {
  await page.goto(link);
  await expect(page.getByRole('tab', { name: 'Receiving' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  // Following a share link connects on its own: the paste form is replaced by
  // the connecting state without anyone clicking Connect.
  await expect(page.getByText('Connecting and asking for the file list...')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect' })).toHaveCount(0);
}

function fileRow(page: Page, name: string): Locator {
  return page.locator('li.file-row').filter({ has: page.getByText(name, { exact: true }) });
}

async function offerListed(page: Page, names: readonly string[]): Promise<void> {
  await expect(page.locator('li.file-row')).toHaveCount(names.length);
  for (const name of names) {
    await expect(fileRow(page, name)).toHaveCount(1);
  }
}

// `fileRow` above is deliberately unscoped, and the existing tests call it while
// the queue panel is still empty. Once a file is queued it renders twice — once
// in the offer list and once in the panel, both as `li.file-row` — so the
// assertions below go through `offerRow`, which is pinned to the first
// `ul.file-list`. The panel's list is second in the DOM, and the row scoped
// lookups that hang off this are still unambiguous because the extra
// `li.file-row` in the panel is not one of their ancestors.
function offerRow(page: Page, name: string): Locator {
  return page
    .locator('ul.file-list')
    .first()
    .locator('li.file-row')
    .filter({ has: page.getByText(name, { exact: true }) });
}

async function openMenu(page: Page, name: string): Promise<Locator> {
  const row = offerRow(page, name);
  const trigger = row.getByRole('button', { name: `More actions for ${name}` });
  await expect(trigger).toBeEnabled();
  await trigger.click();
  const menu = row.getByRole('menu');
  await expect(menu).toBeVisible();
  return menu;
}

// The one item in the menu is the same in every state, so a queued row and a
// saved row are both taken through a button that just says Download.
async function queueFile(page: Page, name: string): Promise<void> {
  const menu = await openMenu(page, name);
  await menu.getByRole('menuitem', { name: 'Download' }).click();
  await expect(page.getByLabel('Download queue').getByText(name, { exact: true })).toBeVisible();
}

// Waits for the file to be SAVED, which is a state with no positive marker of
// its own: a saved row has left the panel, dropped its progress bar, and
// carries no state label at all (STATE_TEXT.saved is defined but never
// rendered), while a queued row is still in the panel, a downloading row still
// has its bar and its progress text, and a failed row has `span.error.small`.
// So the contract is the conjunction of those four absences, and each one
// excludes a state the old "left the panel" check would have accepted.
//
// The bar is addressed by element rather than by role because `progress` is not
// an ARIA role — the element computes as progressbar, and
// getByRole('progress') is rejected by Playwright's own role list. It is
// asserted as an absence rather than a presence because waiting for it to
// appear catches a short-lived element: a small file is saved before the
// element handle has been polled.
async function downloadFile(page: Page, name: string): Promise<void> {
  const menu = await openMenu(page, name);
  await menu.getByRole('menuitem', { name: 'Download' }).click();
  const row = offerRow(page, name);
  await expect(page.getByLabel('Download queue').getByText(name, { exact: true })).toHaveCount(0);
  await expect(row.locator('progress')).toHaveCount(0);
  await expect(row.locator('span.muted.small'), 'a saved row has no state label').toHaveCount(0);
  await expect(row.locator('span.error.small'), 'a saved row did not fail').toHaveCount(0);
}

async function installDiskSink(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const files: {
      suggestedName: string | null;
      bytes: number;
      closed: boolean;
      aborted: boolean;
      read(): string;
    }[] = [];
    const probe: E2EDiskProbe = { calls: 0, files };
    window.__e2eDisk = probe;
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      writable: true,
      value: async (options?: { suggestedName?: string }) => {
        probe.calls += 1;
        const chunks: Uint8Array[] = [];
        const record = {
          suggestedName: options?.suggestedName ?? null,
          bytes: 0,
          closed: false,
          aborted: false,
          read(): string {
            const out = new Uint8Array(record.bytes);
            let offset = 0;
            for (const chunk of chunks) {
              out.set(chunk, offset);
              offset += chunk.length;
            }
            chunks.length = 0;
            let binary = '';
            for (let i = 0; i < out.length; i += 1) binary += String.fromCharCode(out[i] as number);
            return btoa(binary);
          },
        };
        files.push(record);
        return {
          write: async (chunk: Uint8Array): Promise<void> => {
            chunks.push(new Uint8Array(chunk));
            record.bytes += chunk.length;
          },
          close: async (): Promise<void> => {
            record.closed = true;
          },
          abort: async (): Promise<void> => {
            record.aborted = true;
          },
        };
      },
    });
  });
}

async function installHandleShapedPicker(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const files: {
      suggestedName: string | null;
      bytes: number;
      closed: boolean;
      aborted: boolean;
      read(): string;
    }[] = [];
    const probe: E2EDiskProbe = { calls: 0, files };
    window.__e2eDisk = probe;
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      writable: true,
      // Resolves with a FileSystemFileHandle, the way some Chrome builds do.
      value: async (options?: { suggestedName?: string }) => {
        probe.calls += 1;
        const chunks: Uint8Array[] = [];
        const record = {
          suggestedName: options?.suggestedName ?? null,
          bytes: 0,
          closed: false,
          aborted: false,
          read(): string {
            const out = new Uint8Array(record.bytes);
            let offset = 0;
            for (const chunk of chunks) {
              out.set(chunk, offset);
              offset += chunk.length;
            }
            chunks.length = 0;
            let binary = '';
            for (let i = 0; i < out.length; i += 1) binary += String.fromCharCode(out[i] as number);
            return btoa(binary);
          },
        };
        files.push(record);
        return {
          kind: 'file',
          name: record.suggestedName ?? 'picked',
          getFile: async () => new File([], record.suggestedName ?? 'picked'),
          createWritable: async () => ({
            write: async (chunk: Uint8Array): Promise<void> => {
              chunks.push(new Uint8Array(chunk));
              record.bytes += chunk.length;
            },
            close: async (): Promise<void> => {
              record.closed = true;
            },
            abort: async (): Promise<void> => {
              record.aborted = true;
            },
          }),
        };
      },
    });
  });
}

async function removeDiskSink(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      writable: true,
      value: undefined,
    });
  });
}

// The receiving row mounts its <progress> the instant the row turns
// "downloading", before any bytes move, so recording the labels that were ever
// mounted is deterministic where asserting on the live element would race the
// transfer.
async function traceRowProgress(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen: string[] = [];
    window.__e2eRowProgress = seen;
    const collect = (records: MutationRecord[]): void => {
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) {
          if (!(node instanceof Element)) continue;
          const bars = node.matches('li.file-row progress')
            ? [node]
            : Array.from(node.querySelectorAll('li.file-row progress'));
          for (const bar of bars) {
            const label = bar.getAttribute('aria-label');
            if (label !== null && !seen.includes(label)) seen.push(label);
          }
        }
      }
    };
    const observer = new MutationObserver(collect);
    const start = (): void => {
      if (document.body === null) return;
      observer.observe(document.body, { childList: true, subtree: true });
    };
    if (document.body === null) {
      document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
      start();
    }
  });
}

async function observedRowProgress(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    if (window.__e2eRowProgress === undefined) {
      throw new Error('the row progress trace was never installed');
    }
    return window.__e2eRowProgress;
  });
}

// Every error banner the page ever mounted, in mount order, by the text it
// carried. The same reasoning as traceRowProgress above, and needed for the same
// kind of reason: a banner that a skip raised is gone again within a frame or
// two, because the very next file's `runOne` calls `setError(null)` on its way
// past, so a `getByRole('alert')` count read a moment later is 0 whether or not
// the user was ever shown one. That count is still asserted below, for the state
// the pages are left in; this is what says the banner was never raised.
async function traceAlerts(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen: string[] = [];
    window.__e2eAlerts = seen;
    const record = (element: Element): void => {
      seen.push(element.textContent ?? '');
    };
    const collect = (records: MutationRecord[]): void => {
      for (const entry of records) {
        for (const node of Array.from(entry.addedNodes)) {
          if (!(node instanceof Element)) continue;
          if (node.matches('[role="alert"]')) record(node);
          for (const alert of Array.from(node.querySelectorAll('[role="alert"]'))) record(alert);
        }
      }
    };
    const observer = new MutationObserver(collect);
    const start = (): void => {
      if (document.body === null) return;
      observer.observe(document.body, { childList: true, subtree: true });
      // A banner already on the page when the observer starts was mounted before
      // it could see anything, so it is picked up by hand.
      for (const alert of Array.from(document.querySelectorAll('[role="alert"]'))) record(alert);
    };
    if (document.body === null) {
      document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
      start();
    }
  });
}

async function observedAlerts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    if (window.__e2eAlerts === undefined) {
      throw new Error('the alert trace was never installed');
    }
    return window.__e2eAlerts;
  });
}

async function diskWrites(page: Page): Promise<DiskWrite[]> {
  return page.evaluate(() => {
    const disk = window.__e2eDisk;
    if (disk === undefined) throw new Error('the disk sink probe was never installed');
    return disk.files.map((file) => ({
      suggestedName: file.suggestedName,
      bytes: file.bytes,
      closed: file.closed,
      aborted: file.aborted,
      base64: file.read(),
    }));
  });
}

function expectWrittenAs(written: DiskWrite, expected: E2EFile): void {
  expect(written.bytes, `bytes written for ${expected.name}`).toBe(expected.bytes.length);
  expect(written.closed, `${expected.name} was closed`).toBe(true);
  expect(written.aborted, `${expected.name} was not aborted`).toBe(false);
  const received = Buffer.from(written.base64, 'base64');
  expect(received.length, `length of ${expected.name}`).toBe(expected.bytes.length);
  expect(sha256(received), `sha256 of ${expected.name}`).toBe(sha256(expected.bytes));
  expect(received.equals(expected.bytes), `${expected.name} is byte for byte identical`).toBe(true);
}

async function spyOnSockets(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const urls: string[] = [];
    window.__e2eSockets = urls;
    const Original = window.WebSocket;
    (window as unknown as { WebSocket: unknown }).WebSocket = new Proxy(Original, {
      construct: (target, args: unknown[]) => {
        urls.push(String(args[0]));
        return Reflect.construct(target, args);
      },
    });
  });
}

async function leakReport(page: Page, token: string): Promise<string[]> {
  const roomId = roomIdOf(token);
  const storage = await page.evaluate(() => ({
    local: Object.keys(localStorage).map((key) => localStorage.getItem(key) ?? ''),
    session: Object.keys(sessionStorage).map((key) => sessionStorage.getItem(key) ?? ''),
  }));
  const seen: string[] = [];
  for (const [label, values] of [
    ['localStorage', storage.local],
    ['sessionStorage', storage.session],
  ] as const) {
    for (const value of values) {
      if (value.includes(token)) seen.push(`${label} contains the token`);
      if (value.includes(roomId)) seen.push(`${label} contains the room code`);
    }
  }
  return seen;
}

test('rejects a corrupted share link without attempting a connection', async ({ browser }) => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['p2fs1qqqqqqqqqqqq', 'valid share link'],
    [truncatedToken(), 'incomplete'],
  ];

  for (const [token, expected] of cases) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await spyOnSockets(page);
    const requests: string[] = [];
    page.on('request', (request) => requests.push(request.url()));

    await page.goto('/');
    await page.getByRole('tab', { name: 'Receiving' }).click();
    await page.getByLabel('Share token').fill(token);

    const started = Date.now();
    await page.getByRole('button', { name: 'Connect' }).click();
    await expect(page.getByRole('alert')).toContainText(expected);
    const elapsed = Date.now() - started;

    await expect(page.getByText('Connecting and asking for the file list...')).toHaveCount(0);
    const sockets = await page.evaluate(() => window.__e2eSockets ?? []);
    expect(sockets, `WebSockets opened for ${token}`).toEqual([]);
    expect(
      requests.filter((url) => /peerjs/i.test(url)),
      `signalling requests for ${token}`,
    ).toEqual([]);
    expect(elapsed, `reject budget for ${token}`).toBeLessThan(REJECT_BUDGET_MS);

    await context.close();
  }
});

test('pairs each tab with its panel and switches tabs from the keyboard', async ({ page }) => {
  await page.goto('/');

  const share = page.getByRole('tab', { name: 'Sharing' });
  const receive = page.getByRole('tab', { name: 'Receiving' });
  const panel = page.getByRole('tabpanel');

  await expect(share).toHaveAttribute('id', 'tab-share');
  await expect(receive).toHaveAttribute('id', 'tab-receive');
  await expect(panel).toHaveAttribute('id', 'panel');

  for (const tab of [share, receive] as Locator[]) {
    const controls = await tab.getAttribute('aria-controls');
    expect(controls).toBe('panel');
    await expect(page.locator(`#${controls as string}`)).toHaveCount(1);
  }

  await expect(share).toHaveAttribute('aria-selected', 'true');
  await expect(receive).toHaveAttribute('aria-selected', 'false');
  await expect(share).toHaveAttribute('tabindex', '0');
  await expect(receive).toHaveAttribute('tabindex', '-1');
  await expect(panel).toHaveAttribute('aria-labelledby', 'tab-share');

  await receive.click();
  await expect(receive).toHaveAttribute('aria-selected', 'true');
  await expect(share).toHaveAttribute('aria-selected', 'false');
  await expect(share).toHaveAttribute('tabindex', '-1');
  await expect(receive).toHaveAttribute('tabindex', '0');
  await expect(panel).toHaveAttribute('aria-labelledby', 'tab-receive');

  await receive.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(share).toHaveAttribute('aria-selected', 'true');
  await expect(panel).toHaveAttribute('aria-labelledby', 'tab-share');

  await page.keyboard.press('ArrowRight');
  await expect(receive).toHaveAttribute('aria-selected', 'true');
  await expect(panel).toHaveAttribute('aria-labelledby', 'tab-receive');
});

test('keeps every button legible against the panel it sits on', async ({ page }) => {
  // The base button style is a pair: a light accent fill with near-black text,
  // chosen together. A rule that overrides the fill without also overriding the
  // text leaves near-black on the dark panel, which is unreadable rather than
  // merely ugly - so this measures contrast rather than eyeballing it.
  await page.goto('/');
  await page.evaluate(() => {
    const app = document.querySelector('.app');
    if (app === null) throw new Error('the app shell is missing');
    app.insertAdjacentHTML(
      'beforeend',
      `<div class="card stack">
         <ul class="file-list">
           <li class="file-row transfer">
             <div class="row between">
               <span class="grow">notes.pdf</span>
               <span class="muted">1.2 MB</span>
               <button type="button" class="menu" aria-haspopup="menu">
                 <span aria-hidden="true">&#8942;</span>
               </button>
             </div>
              <div class="menu-panel"><button type="button">Download</button></div>
            </li>
          </ul>
          <section class="queue" aria-label="Download queue">
            <ul class="file-list">
              <li class="file-row">
                <span class="grow">notes.pdf</span>
                <button type="button" class="secondary" aria-label="Remove notes.pdf from queue">
                  <span aria-hidden="true">&times;</span>
                </button>
              </li>
            </ul>
          </section>
        </div>`,
    );
  });

  const report = await page.evaluate(() => {
    const parse = (value: string): number[] =>
      (value.match(/[\d.]+/g) ?? ['0', '0', '0']).slice(0, 3).map(Number);
    const luminance = (rgb: number[]): number => {
      const [r, g, b] = rgb.map((v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * (r as number) + 0.7152 * (g as number) + 0.0722 * (b as number);
    };
    const contrast = (a: string, b: string): number => {
      const pair = [luminance(parse(a)), luminance(parse(b))].sort((x, y) => y - x);
      return ((pair[0] as number) + 0.05) / ((pair[1] as number) + 0.05);
    };
    // The panel a row sits on, then every button on every probe row, measured as
    // rendered. More than one row, because a row that carries only a `secondary`
    // control is a different case from one that carries a menu as well.
    const rows = [...document.querySelectorAll('li.file-row')];
    if (rows.length === 0) throw new Error('the probe rows are missing');
    const panel = getComputedStyle(rows[0]?.closest('.card') as Element).backgroundColor;
    const buttons = rows.flatMap((row) =>
      [...row.querySelectorAll('button')].map((button) => ({
        label: button.getAttribute('aria-label') ?? button.className ?? 'menu item',
        text: getComputedStyle(button).color,
        fill: getComputedStyle(button).backgroundColor,
        ratio: Number(contrast(getComputedStyle(button).color, panel).toFixed(2)),
      })),
    );
    return { panel, buttons };
  });

  // 4.5 is the WCAG AA threshold for body text; a control's own label is text.
  for (const button of report.buttons) {
    expect(
      button.ratio,
      `${button.label} text ${button.text} on the panel ${report.panel}`,
    ).toBeGreaterThanOrEqual(4.5);
  }
});

test('disables both tabs when the environment cannot connect', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    Object.defineProperty(window, 'RTCPeerConnection', {
      configurable: true,
      writable: true,
      value: undefined,
    });
  });
  await page.getByRole('tab', { name: 'Receiving' }).click();

  await expect(page.getByRole('alert')).toContainText(/peer-to-peer/i);
  await expect(page.getByRole('tab', { name: 'Sharing' })).toBeDisabled();
  await expect(page.getByRole('tab', { name: 'Receiving' })).toBeDisabled();
});

test('opens the receiving tab straight from a share link in the fragment', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('tab', { name: 'Sharing' })).toHaveAttribute(
    'aria-selected',
    'true',
  );

  await page.goto(`/#${FAKE_TOKEN}`);
  await page.reload();

  await expect(page.getByRole('tab', { name: 'Receiving' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByLabel('Share token')).toHaveValue(FAKE_TOKEN);
});

test('ignores a share token that arrives in a query parameter', async ({ page }) => {
  await page.goto(`/?s=${FAKE_TOKEN}`);

  await expect(page.getByRole('tab', { name: 'Sharing' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByLabel('Share token')).toHaveCount(0);
});

test('never asks the server for anything containing the token', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));

  await page.goto(`/#${FAKE_TOKEN}`);

  await expect(page.getByLabel('Share token')).toBeVisible();
  expect(requests.filter((url) => url.includes('p2fs1'))).toEqual([]);
});

test('defaults the connection servers to the ones the app used before', async ({ page }) => {
  // No E2E_LIVE gate: the picker is drawn from a table and a stored selection,
  // and neither reaches the network until the token is minted - which is what
  // the next test covers. This one only reads what the page is showing.
  const file = await makeFile(FILE_A, FILE_A_SEED, FILE_A_BYTES);
  await page.goto('/');
  await page.getByLabel('Choose files to share').setInputFiles([file.path]);
  await openPicker(page);

  // Today's behaviour: address discovery from Google STUN, and both PeerJS
  // relays, because a fork that had narrowed the list would have been a change
  // the app's users could see in a connection that no longer works.
  expect(await selectionIn(page), 'the default selection').toEqual({
    enabled: [STUN_INDEX, EU_RELAY_INDEX, US_RELAY_INDEX],
    relay: EU_RELAY_INDEX,
  });
  for (const [index] of SERVER_NAMES.entries()) {
    await expect(serverCheckbox(page, index), `${SERVER_NAMES[index]} is on by default`).toBeChecked();
  }

  // A STUN server discovers an address and cannot carry traffic, so its radio is
  // disabled rather than hidden - the entry is in the list and the reason is in
  // the copy, and a disabled control is what says so.
  await expect(relayRadio(page, STUN_INDEX), 'a STUN entry cannot be designated').toBeDisabled();
  await expect(relayRadio(page, EU_RELAY_INDEX), 'the default relay is designated').toBeChecked();
  await expect(relayRadio(page, US_RELAY_INDEX), 'the other relay is a choice').toBeEnabled();
  await expect(relayRadio(page, US_RELAY_INDEX)).not.toBeChecked();
  // And the designated relay is forced into the config, so its own checkbox is
  // out of reach: switching it off would be a lie about what is being used.
  await expect(serverCheckbox(page, EU_RELAY_INDEX), 'the designated relay cannot be switched off')
    .toBeDisabled();

  // The renderer puts every checkbox first and the radio group after them, not
  // one of each per server. Pinned because a per-server row now holds a checkbox
  // and nothing else, so a locator that walks a mixed list positionally is
  // wrong here, while the checkbox order and the radio order are each stable.
  expect(
    await page
      .locator('.server-list > *')
      .evaluateAll((rows) =>
        rows.map((row) => (row.querySelector('input[type="radio"]') === null ? 'checkbox' : 'radio')),
      ),
    'the picker renders all three checkboxes and then the radio group',
  ).toEqual(['checkbox', 'checkbox', 'checkbox', 'radio']);

  // A selection equal to the default says so by saying nothing at all, and the
  // picker adds no live region: there is no role="status" on this page yet.
  await expect(deviationLine(page), 'no deviation line over the default').toHaveCount(0);
  await expect(resetButton(page), 'no reset button over the default').toHaveCount(0);
  await expect(noDiscoveryWarning(page), 'the default has address discovery').toHaveCount(0);
  expect(await page.getByRole('status').count(), 'live regions in the ready phase').toBe(0);

  // A build naming its own relay with VITE_TURN_* replaces the whole picker with
  // a paragraph, so the summary going missing is this test failing rather than
  // every assertion below it quietly matching nothing.
  await expect(page.locator('details.advanced')).toHaveCount(1);
});

test('remembers the chosen servers across a reload, and resets them', async ({ page }) => {
  const file = await makeFile(FILE_A, FILE_A_SEED, FILE_A_BYTES);
  await page.goto('/');
  await page.getByLabel('Choose files to share').setInputFiles([file.path]);
  await openPicker(page);

  // Designating a relay that is already switched on moves the designation and
  // switches nothing else on or off, and it disables that relay's checkbox.
  await relayRadio(page, US_RELAY_INDEX).check();
  expect(await selectionIn(page), 'designating the other relay').toEqual({
    enabled: [STUN_INDEX, EU_RELAY_INDEX, US_RELAY_INDEX],
    relay: US_RELAY_INDEX,
  });
  await expect(serverCheckbox(page, EU_RELAY_INDEX), 'the relay that was designated before').toBeChecked();
  await expect(serverCheckbox(page, US_RELAY_INDEX)).toBeDisabled();

  // Switching the only STUN entry off leaves the sender with no way to find its
  // own public address, which the picker says rather than leaving to be
  // inferred.
  await serverCheckbox(page, STUN_INDEX).uncheck();
  expect(await selectionIn(page), 'STUN off and the other relay designated').toEqual({
    enabled: [EU_RELAY_INDEX, US_RELAY_INDEX],
    relay: US_RELAY_INDEX,
  });
  await expect(noDiscoveryWarning(page)).toBeVisible();
  await expect(deviationLine(page)).toHaveText(
    'Not the default: relay PeerJS US, enabled: PeerJS EU, PeerJS US.',
  );
  await expect(resetButton(page)).toBeEnabled();

  // Stored, not just drawn: a reload is the only way to see that the choice was
  // persisted, and the read back from storage rather than from the controls so
  // that a picker painting the right thing from the wrong source would show up.
  expect(await storedSelection(page), 'the persisted selection').toEqual({
    enabled: [EU_RELAY_INDEX, US_RELAY_INDEX],
    relay: US_RELAY_INDEX,
  });

  await page.reload();
  await page.getByLabel('Choose files to share').setInputFiles([file.path]);
  await openPicker(page);
  expect(await selectionIn(page), 'the selection after a reload').toEqual({
    enabled: [EU_RELAY_INDEX, US_RELAY_INDEX],
    relay: US_RELAY_INDEX,
  });
  await expect(deviationLine(page)).toBeVisible();
  await expect(noDiscoveryWarning(page)).toBeVisible();

  // Reset puts the default back, and the deviation line and the warning go with
  // it - the line is not decoration over a selection that is still the old one.
  await resetButton(page).click();
  expect(await selectionIn(page), 'the selection after a reset').toEqual({
    enabled: [STUN_INDEX, EU_RELAY_INDEX, US_RELAY_INDEX],
    relay: EU_RELAY_INDEX,
  });
  expect(await storedSelection(page), 'the persisted selection after a reset').toEqual({
    enabled: [STUN_INDEX, EU_RELAY_INDEX, US_RELAY_INDEX],
    relay: EU_RELAY_INDEX,
  });
  await expect(deviationLine(page)).toHaveCount(0);
  await expect(resetButton(page)).toHaveCount(0);
  await expect(noDiscoveryWarning(page)).toHaveCount(0);
});

test('falls back to the default selection for a stored value it cannot trust', async ({ browser }) => {
  // `localStorage` holds whatever a previous build, another tab or a person with
  // devtools left there, and it is read once at mount. The last case is one the
  // picker must honour, which is what proves the seeding reached the app at all
  // for every case; the rest must be ignored, each for its own reason. A fresh
  // context per case is what keeps one case's stored value out of the next.
  const file = await makeFile(FILE_A, FILE_A_SEED, FILE_A_BYTES);
  const DEFAULT = {
    enabled: [STUN_INDEX, EU_RELAY_INDEX, US_RELAY_INDEX],
    relay: EU_RELAY_INDEX,
  };
  const cases: ReadonlyArray<{
    label: string;
    stored: string | null;
    expect: E2ESelection;
    deviation: string | null;
    noDiscovery: boolean;
  }> = [
    {
      label: 'nothing stored at all',
      stored: null,
      expect: DEFAULT,
      deviation: null,
      noDiscovery: false,
    },
    {
      label: 'not JSON',
      stored: '{enabled:[0,1,2],relay:',
      expect: DEFAULT,
      deviation: null,
      noDiscovery: false,
    },
    {
      label: 'a JSON scalar',
      stored: '7',
      expect: DEFAULT,
      deviation: null,
      noDiscovery: false,
    },
    {
      label: 'enabled is a string, not an array',
      stored: '{"enabled":"0,1,2","relay":1}',
      expect: DEFAULT,
      deviation: null,
      noDiscovery: false,
    },
    {
      label: 'enabled is missing',
      stored: '{"relay":2}',
      expect: DEFAULT,
      deviation: null,
      noDiscovery: false,
    },
    {
      label: 'relay names a STUN entry, which cannot carry',
      stored: '{"enabled":[0,1,2],"relay":0}',
      expect: DEFAULT,
      deviation: null,
      noDiscovery: false,
    },
    {
      label: 'relay is an index this build has no entry for',
      stored: '{"enabled":[0,1,2],"relay":7}',
      expect: DEFAULT,
      deviation: null,
      noDiscovery: false,
    },
    {
      label: 'relay is not a number',
      stored: '{"enabled":[0,1,2],"relay":"1"}',
      expect: DEFAULT,
      deviation: null,
      noDiscovery: false,
    },
    {
      label: 'an index past the end of the table',
      stored: '{"enabled":[0,1,255],"relay":1}',
      expect: { enabled: [STUN_INDEX, EU_RELAY_INDEX], relay: EU_RELAY_INDEX },
      deviation: 'Not the default: relay PeerJS EU, enabled: Google STUN, PeerJS EU.',
      noDiscovery: false,
    },
    {
      label: 'an index that is a string',
      stored: '{"enabled":[0,1,"2"],"relay":1}',
      expect: { enabled: [STUN_INDEX, EU_RELAY_INDEX], relay: EU_RELAY_INDEX },
      deviation: 'Not the default: relay PeerJS EU, enabled: Google STUN, PeerJS EU.',
      noDiscovery: false,
    },
    {
      label: 'the same index twice',
      stored: '{"enabled":[1,1,2],"relay":1}',
      expect: { enabled: [EU_RELAY_INDEX, US_RELAY_INDEX], relay: EU_RELAY_INDEX },
      deviation: 'Not the default: relay PeerJS EU, enabled: PeerJS EU, PeerJS US.',
      noDiscovery: true,
    },
    {
      // An empty list is a list, so it is not a malformed value to be ignored -
      // it is a selection of nothing, and the designated relay is put back into
      // it so the config and the checkboxes cannot disagree.
      label: 'an empty enabled list',
      stored: '{"enabled":[],"relay":1}',
      expect: { enabled: [EU_RELAY_INDEX], relay: EU_RELAY_INDEX },
      deviation: 'Not the default: relay PeerJS EU, enabled: PeerJS EU.',
      noDiscovery: true,
    },
    {
      // The one that must be honoured, and the proof that the seed above was
      // read rather than skipped: the picker shows a selection no default could
      // produce, from the same seeding, in the same pass.
      label: 'a valid selection',
      stored: '{"enabled":[2],"relay":2}',
      expect: { enabled: [US_RELAY_INDEX], relay: US_RELAY_INDEX },
      deviation: 'Not the default: relay PeerJS US, enabled: PeerJS US.',
      noDiscovery: true,
    },
  ];

  for (const entry of cases) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await seedIceSelection(page, entry.stored);
    await page.goto('/');
    await page.getByLabel('Choose files to share').setInputFiles([file.path]);
    await openPicker(page);

    expect(await selectionIn(page), entry.label).toEqual(entry.expect);
    if (entry.deviation === null) {
      await expect(deviationLine(page), `${entry.label}: no deviation line`).toHaveCount(0);
      await expect(resetButton(page), `${entry.label}: no reset button`).toHaveCount(0);
    } else {
      await expect(deviationLine(page), `${entry.label}: the deviation line`).toHaveText(
        entry.deviation,
      );
      await expect(resetButton(page), `${entry.label}: the reset button`).toBeEnabled();
    }
    if (entry.noDiscovery) {
      await expect(noDiscoveryWarning(page), `${entry.label}: the discovery warning`).toBeVisible();
    } else {
      await expect(noDiscoveryWarning(page), `${entry.label}: no discovery warning`).toHaveCount(0);
    }

    // The app does not write the selection back on the way in, so the seeded
    // string is still there afterwards. That is the other half of the argument
    // for the cases that fell back: the default on screen is a decision about a
    // value that was demonstrably present, not a page that never saw one.
    expect(
      await page.evaluate((key: string) => localStorage.getItem(key), ICE_STORAGE_KEY),
      `${entry.label}: the seeded value survived the read`,
    ).toBe(entry.stored);

    await context.close();
  }
});

test('does not resurrect a share session when the files change mid-start', async ({ browser }) => {
  test.skip(!LIVE, SKIP_LIVE);

  const file = await makeFile(FILE_A, FILE_A_SEED, FILE_A_BYTES);
  const errors: string[] = [];
  const context = await browser.newContext();
  const page = await context.newPage();
  await trackPageErrors(page, 'share', errors);

  await page.goto('/');
  await page.getByLabel('Choose files to share').setInputFiles([file.path]);
  const create = page.getByRole('button', { name: 'Create share token' });
  await expect(create).toBeVisible();

  // The share start is a WebSocket round trip to the public broker, and until it
  // resolves the Create button is replaced by Starting... — which unmounts
  // Choose different files too. So the broker socket is armed before the click
  // and awaited immediately after it: the click lands inside the pending window
  // every time, rather than racing a slow broker and silently testing nothing.
  //
  // The wait is bounded and asserted rather than awaited bare, because the
  // socket opening is also the proof that the start got as far as the broker at
  // all. If the stale-start guard were removed, host() would return before
  // PeerSession.open, no socket would ever appear, and the assertions below
  // would pass vacuously — so this is the line that has to go red.
  const brokerSocket = page
    .waitForEvent('websocket', {
      predicate: (socket) => /(^|\.)peerjs\.com$/i.test(new URL(socket.url()).hostname),
      timeout: BROKER_SOCKET_MS,
    })
    .then(
      () => true,
      () => false,
    );
  await create.click();
  await page.getByRole('button', { name: 'Choose different files' }).click();
  const started = await brokerSocket;
  expect(
    started,
    'the share start reached the broker, so the stale-start guard was exercised',
  ).toBe(true);

  // The round trip has demonstrably begun. Only now does the timed wait start,
  // so it covers the remainder of the handshake rather than whatever was left
  // of a fixed 5s.
  await page.waitForTimeout(5000);

  await expect(page.getByLabel('Choose files to share')).toBeVisible();
  await expect(page.getByLabel('Share token')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(errors).toEqual([]);

  await context.close();
});

test('lists two shared files and writes both to disk over one connection', async ({ browser }) => {
  test.skip(!LIVE, SKIP_LIVE);
  // Two files queued, one 4MB transfer observed in flight, a save dialog per
  // file, a wire trace over a real connection, and two contexts to tear down —
  // comfortably more than the default 90s budget on a slow broker run.
  test.slow();

  // The first file is the big one so that the queue is observably holding two
  // files while both are still waiting; see FILE_HOLD for the measurement.
  const first = await makeFile(FILE_HOLD, FILE_HOLD_SEED, FILE_HOLD_BYTES);
  const second = await makeFile(FILE_B, FILE_B_SEED, FILE_B_BYTES);
  const errors: string[] = [];

  const senderContext = await browser.newContext({
    acceptDownloads: true,
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const receiverContext = await browser.newContext({ acceptDownloads: true });
  const sender = await senderContext.newPage();
  const receiver = await receiverContext.newPage();
  await trackPageErrors(sender, 'sender', errors);
  await trackPageErrors(receiver, 'receiver', errors);
  await installDiskSink(receiver);
  await traceRowProgress(receiver);
  const senderTrace = traceWire(sender);
  const receiverTrace = traceWire(receiver);

  const token = await startSharing(sender, [first, second]);
  expect(await readCopiedToken(sender, token)).toBe(token);
  const link = await readShareLink(sender, token);
  requireSameOriginLink(sender, link);

  await connectFromLink(receiver, link);
  await expect(receiver.getByText('2 files are on offer.')).toBeVisible();
  await offerListed(receiver, [first.name, second.name]);

  // An untouched row renders no state label at all: STATE_TEXT.waiting is the
  // empty string and the span is not rendered. So this is asserted before
  // anything is queued, where "nobody has asked for it" is a fact rather than a
  // race — a queued row says Queued, and this is a queued row's counterpart.
  await expect(
    offerRow(receiver, second.name).locator('span.muted.small'),
    'a row nobody has asked for says nothing',
  ).toHaveCount(0);

  // Both files are queued before either is fetched, so the queue is what
  // proves the sequencing: the second row is only reached once the first has
  // drained. Both being in the panel at once is the claim, and it is only
  // reachable while the first is still in flight — so `Queue (2 files)` is a
  // race between FILE_HOLD's ~2.8s drain and the two `queueFile` actions above
  // (~200ms of menu and click work) over a public broker on arbitrary
  // hardware. FILE_HOLD is that size for this reason; see its declaration.
  await queueFile(receiver, first.name);
  await queueFile(receiver, second.name);
  await expect(receiver.getByLabel('Download queue')).toContainText('Queue (2 files)');
  await expect(liveRegion(receiver)).toHaveText('Saved to disk.');

  // The sender numbers each DataConnection, so both files landing on
  // "Receiver 1" is the proof that one connection carried both transfers.
  await expect(sender.locator('li.file-row.transfer')).toHaveCount(2);
  for (const file of [first, second]) {
    const row = sender.locator('li.file-row').filter({ hasText: `Receiver 1 · ${file.name}` });
    await expect(row).toHaveCount(1);
    await expect(row.locator('progress')).toHaveAttribute(
      'aria-label',
      `Receiver 1: ${file.name}`,
    );
    await expect(row).toContainText('delivered.');
  }
  await expect(liveRegion(sender)).toHaveText(`Sent ${second.name} to Receiver 1.`);

  // observedRowProgress records the labels in mount order, so the ordered pair
  // is what proves the queue fetched the files in the order they were clicked
  // and not in manifest order or at random. It is read here, after the sender
  // has both rows delivered, so both labels are in the trace — read one line
  // earlier, "Saved to disk." is the FIRST file landing and the second may not
  // have mounted its bar yet.
  expect(
    await observedRowProgress(receiver),
    'the files were fetched in the order they were queued',
  ).toEqual([`Downloading ${first.name}`, `Downloading ${second.name}`]);

  // A saved file is still takeable through the same menu action, so there is
  // no second label for it: the item reads Download whether the row is queued,
  // downloading or saved. Re-serving repeats the nonce, but repeats the
  // plaintext with it, so it hands the peer nothing new.
  const replay = await openMenu(receiver, first.name);
  await expect(replay.getByRole('menuitem', { name: 'Download' })).toBeEnabled();

  const writes = await diskWrites(receiver);
  expect(writes.length, 'showSaveFilePicker invocations').toBe(2);
  const byName = new Map(writes.map((write) => [write.suggestedName ?? '', write]));
  expect([...byName.keys()].sort(), 'the names offered to the save picker').toEqual(
    [first.name, second.name].sort(),
  );
  for (const file of [first, second]) {
    const write = byName.get(file.name);
    if (write === undefined) throw new Error(`nothing was written as ${file.name}`);
    expectWrittenAs(write, file);
  }

  // Done tears the list down and returns to the idle form, so the status line
  // replaces the "Saved to disk." line. The pasted link is kept, so the same
  // share can be reopened.
  await receiver.getByRole('button', { name: 'Done' }).click();
  await expect(liveRegion(receiver)).toHaveText('Done. The share is closed.');
  await expect(receiver.getByText('2 files are on offer.')).toHaveCount(0);
  await expect(receiver.getByLabel('Share token')).toHaveValue(token);
  await expect(receiver.getByRole('button', { name: 'Connect' })).toBeVisible();

  expect(await leakReport(sender, token)).toEqual([]);
  expect(await leakReport(receiver, token)).toEqual([]);
  // The receiver connected, decoded the token and pulled both files over it, so
  // the token has been a live string in page memory for the whole transfer.
  // If any of that leaked onto the wire, this is where it shows.
  expect(
    await wireLeakReport(receiverTrace.wire, receiverTrace.bodies, token),
    'every request and WebSocket the receiver opened',
  ).toEqual([]);
  expect(
    await wireLeakReport(senderTrace.wire, senderTrace.bodies, token),
    'the sender',
  ).toEqual([]);
  expect(
    receiverTrace.wire.some((url) => url.startsWith('wss://')),
    'the receiver opened a signalling socket, so the wire trace saw more than asset loads',
  ).toBe(true);
  expect(errors).toEqual([]);

  await senderContext.close();
  await receiverContext.close();
});

// The one claim this file cannot make is that the filename never reaches the
// other side: it does, inside the sealed manifest, and the receiver could not
// render the file list without it. What a relay cannot read is the content of a
// frame it is obliged to forward, so that is what this asserts - which control
// frames exist on the connection, and what is inside them.
//
// This is the sibling of leakReport/wireLeakReport, not the same assertion: those
// watch requests, WebSockets and storage for the token, which must not appear
// anywhere. Nothing here searches the sealed frames, because a filename in the
// ciphertext is the design, not a leak.
//
// Installed on the sender only, deliberately. The offer originates there, and the
// receiver's four frames - a select, an accept, a done and a finish - never carried
// a name or a size; a trace on the receiver would watch the wrong half of the
// exchange. The accept is the one worth naming: it is the receiver's reply to the
// offer, and it is the frame a reader would most expect to echo the file's name and
// length back, so it is the one this comment has to account for rather than leave
// out. It carries no fields at all (`src/protocol/transfer.ts:514`).
test('carries no filename or size in any cleartext frame', async ({ browser }) => {
  test.skip(!LIVE, SKIP_LIVE);

  const file = await makeFile(FILE_A, FILE_A_SEED, FILE_A_BYTES);
  const errors: string[] = [];

  const senderContext = await browser.newContext({
    acceptDownloads: true,
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const receiverContext = await browser.newContext({ acceptDownloads: true });
  const sender = await senderContext.newPage();
  const receiver = await receiverContext.newPage();
  await trackPageErrors(sender, 'sender', errors);
  await trackPageErrors(receiver, 'receiver', errors);
  await installDiskSink(receiver);
  await captureFrames(sender);

  const token = await startSharing(sender, [file]);
  expect(await readCopiedToken(sender, token)).toBe(token);
  const link = await readShareLink(sender, token);
  requireSameOriginLink(sender, link);

  await connectFromLink(receiver, link);
  await offerListed(receiver, [file.name]);
  await downloadFile(receiver, file.name);
  await expect(liveRegion(receiver)).toHaveText('Saved to disk.');

  // The transfer has to have really happened for the capture to mean anything: a
  // sender that sent nothing at all would also have sent no filename.
  const writes = await diskWrites(receiver);
  expect(writes.length, 'showSaveFilePicker invocations').toBe(1);
  expectWrittenAs(writes[0] as DiskWrite, file);

  const frames = await framesSentBy(sender);

  // What the sender transmits in the clear, stated whole rather than only as a
  // property it does not have: an offer and a done, in that order, and nothing
  // else. A capture that observed nothing, or that missed half the exchange,
  // fails here instead of sailing through the assertions below.
  expect(frames.clear, 'every cleartext frame the sender put on the wire').toEqual([
    '{"t":"offer","chunkSize":65536}',
    '{"t":"done"}',
  ]);
  // And the sealed half went out on the same channel: one manifest plus one
  // frame per chunk of a 300KB file. A count, because a capture that saw only
  // strings is a capture whose wrapper is on the wrong object.
  expect(frames.sealed.length, 'sealed frames the sender put on the wire').toBe(
    1 + Math.ceil(FILE_A_BYTES / CHUNK_SIZE),
  );

  // The file's size went out of the offer but not off the wire. Each chunk is its
  // own data channel message of `plaintext + TAG_BYTES`, so an observer that only
  // forwards the frames - which is all a TURN relay does - can count them, add up
  // their lengths, subtract the tag from each and land on the file's exact byte
  // size without decrypting anything. This measures that recovery instead of
  // trusting the prose, and it is deliberately pinned: if the framing were ever
  // changed to pad chunks or to batch them into fewer messages, this fails. A
  // change to the tag length would *not* fail it, and deliberately so: TAG_BYTES
  // is imported from the code under test, so both sides of the subtraction move
  // together. That failure would be a *good* thing - the size would no longer be
  // derivable and the README's limit would be wrong - so do not "fix" this
  // assertion if it goes red; read it as the claim having changed.
  const chunkFrames = frames.sealed.slice(1);
  const derivedSize = chunkFrames.reduce((sum, length) => sum + length - TAG_BYTES, 0);
  expect(
    derivedSize,
    'the plaintext size a relay can derive from the sealed frame lengths alone',
  ).toBe(FILE_A_BYTES);

  // Each frame searched for the fixture's own generated name and for the decimal
  // byte size it serialises to. Both are long and specific, so neither can be
  // satisfied by an incidental substring: '307200' appears in no chunk size, and
  // 'e2e-share-a.bin' is in no control message this app sends.
  for (const frame of frames.clear) {
    expect(frame, `a cleartext frame carries the filename: ${frame}`).not.toContain(file.name);
    expect(frame, `a cleartext frame carries the byte size: ${frame}`).not.toContain(
      String(FILE_A_BYTES),
    );
  }

  // Read structurally, so a regression that put `name` or `size` back on the
  // offer is a shape change and fails here even if the strings were mangled on
  // the way out.
  const offers = frames.clear.filter((frame) => frame.includes('"t":"offer"'));
  expect(offers.length, 'offer frames the sender sent').toBe(1);
  const offer = offers[0];
  if (offer === undefined) throw new Error('the sender sent no offer frame');
  const parsed = JSON.parse(offer) as Record<string, unknown>;
  expect(Object.keys(parsed).sort(), 'the keys an offer carries on the wire').toEqual([
    'chunkSize',
    't',
  ]);
  expect(parsed['chunkSize'], 'the offer names a chunk size and nothing about the file').toBe(
    CHUNK_SIZE,
  );

  expect(errors).toEqual([]);
  await senderContext.close();
  await receiverContext.close();
});

test('shows the queue panel before anything is queued and cancels one item', async ({ browser }) => {
  test.skip(!LIVE, SKIP_LIVE);
  // Same reason as the two-file test: a 4MB drain observed in flight, plus a
  // second connection, over a public broker.
  test.slow();

  // Big first file, so the queue is observably holding two files while both are
  // still waiting; see FILE_HOLD for the measurement.
  const first = await makeFile(FILE_HOLD, FILE_HOLD_SEED, FILE_HOLD_BYTES);
  const second = await makeFile(FILE_B, FILE_B_SEED, FILE_B_BYTES);
  const errors: string[] = [];

  const senderContext = await browser.newContext({
    acceptDownloads: true,
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const receiverContext = await browser.newContext({ acceptDownloads: true });
  const sender = await senderContext.newPage();
  const receiver = await receiverContext.newPage();
  await trackPageErrors(sender, 'sender', errors);
  await trackPageErrors(receiver, 'receiver', errors);
  await installDiskSink(receiver);

  const token = await startSharing(sender, [first, second]);
  const link = await readShareLink(sender, token);
  requireSameOriginLink(sender, link);
  await connectFromLink(receiver, link);
  await offerListed(receiver, [first.name, second.name]);

  // The panel is up before anything is queued, because a panel that only
  // appears once the queue is non-empty makes the queue itself hard to find.
  const panel = receiver.getByLabel('Download queue');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('Queue (0 files)');
  await expect(panel.getByText('Nothing queued yet.')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Clear all' })).toBeDisabled();

  // An untouched row carries no state label at all.
  await expect(
    offerRow(receiver, first.name).locator('span.muted.small'),
    'a row nobody has asked for says nothing',
  ).toHaveCount(0);

  await queueFile(receiver, first.name);
  await queueFile(receiver, second.name);
  // The panel only counts what is queued plus what is in flight, so this is the
  // same FILE_HOLD-sized race as the two-file test's: ~2.8s of drain to cover
  // the ~200ms of `queueFile` work above.
  await expect(panel).toContainText('Queue (2 files)');
  await expect(panel.getByRole('button', { name: 'Clear all' })).toBeEnabled();

  // One x drops one file and leaves the other alone. It has to be the SECOND
  // file that is cancelled: the pump takes the first item off the queue the
  // moment it is enqueued, so the second row is the one still waiting its turn.
  // Skipping the file already in flight is a different control and a different
  // path -- see 'lets a receiver skip a file that is already downloading'.
  await panel.getByRole('button', { name: `Remove ${second.name} from queue` }).click();
  await expect(panel).toContainText('Queue (1 file)');
  await expect(panel).not.toContainText(second.name);
  await expect(panel).toContainText(first.name);

  // The cancelled row is back to taking orders: no state label, and a live menu.
  await expect(
    offerRow(receiver, second.name).locator('span.muted.small'),
    'a cancelled row says nothing again',
  ).toHaveCount(0);

  // The file that was left drains on its own, and the panel empties as it goes.
  await expect(panel).toContainText('Queue (0 files)');
  await expect(panel.getByText('Nothing queued yet.')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Clear all' })).toBeDisabled();
  const writes = await diskWrites(receiver);
  expect(writes.length, 'showSaveFilePicker invocations').toBe(1);
  const written = writes[0];
  if (written === undefined) throw new Error('nothing was written at all');
  expect(written.suggestedName, 'the one file the queue actually fetched').toBe(first.name);
  expectWrittenAs(written, first);

  expect(errors).toEqual([]);
  await senderContext.close();
  await receiverContext.close();
});

// The sibling of the test above, and the one that reaches the cancel wiring at
// all: dropping a queue entry never touches the abort handle, so this is the
// only test in the file that would notice `inflightRef` or the
// `TransferCancelledError` branch going away. Three files, because the claim is
// about what the skip does not break as much as what it does.
test('lets a receiver skip a file that is already downloading', async ({ browser }) => {
  test.skip(!LIVE, SKIP_LIVE);
  // Same reason as the two-file test, plus a fourth transfer: a 4MB drain caught
  // in flight, three files over one connection and then the skipped one again,
  // all over a public broker.
  test.slow();

  // The 4MB file is queued FIRST and is therefore the one under way when the
  // skip lands: the pump takes the first item off the queue the moment it is
  // enqueued, so which file is in flight is decided by the order of these three
  // calls and not by anything chosen later. The two small ones behind it are
  // what the pump has left to do. See FILE_HOLD for the ~2.8s that makes a window
  // worth asserting in.
  const hold = await makeFile(FILE_HOLD, FILE_HOLD_SEED, FILE_HOLD_BYTES);
  const second = await makeFile(FILE_A, FILE_A_SEED, FILE_A_BYTES);
  const third = await makeFile(FILE_B, FILE_B_SEED, FILE_B_BYTES);
  const errors: string[] = [];

  const senderContext = await browser.newContext({
    acceptDownloads: true,
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const receiverContext = await browser.newContext({ acceptDownloads: true });
  const sender = await senderContext.newPage();
  const receiver = await receiverContext.newPage();
  await trackPageErrors(sender, 'sender', errors);
  await trackPageErrors(receiver, 'receiver', errors);
  await installDiskSink(receiver);
  await traceAlerts(sender);
  await traceAlerts(receiver);

  const token = await startSharing(sender, [hold, second, third]);
  const link = await readShareLink(sender, token);
  requireSameOriginLink(sender, link);
  await connectFromLink(receiver, link);
  await offerListed(receiver, [hold.name, second.name, third.name]);

  const panel = receiver.getByLabel('Download queue');
  await queueFile(receiver, hold.name);
  await queueFile(receiver, second.name);
  // The two queue controls are named apart, so this is also where the file
  // still waiting its turn is shown carrying the other name. Read here rather
  // than at the end: the second file is FILE_A, which the pump cannot reach
  // until the 4MB one has finished, and this assertion sits ~200ms into a
  // ~2.8s drain.
  await expect(
    panel.getByRole('button', { name: `Remove ${second.name} from queue` }),
    'a file still waiting its turn is removable',
  ).toBeVisible();
  await queueFile(receiver, third.name);

  // Under way, not merely queued: the row says Downloading, carries its bar,
  // and the panel's control for it is the skip. The remove name is asserted
  // absent on the same row, which is the split the two controls exist for - a
  // drop control reappearing beside the skip is the regression, and this is
  // where it would be caught by name rather than by a click that quietly dropped
  // a file instead of aborting it.
  const row = offerRow(receiver, hold.name);
  await expect(row.getByText('Downloading', { exact: true })).toBeVisible();
  await expect(row.locator('progress')).toHaveAttribute('aria-label', `Downloading ${hold.name}`);
  const skip = panel.getByRole('button', { name: `Skip ${hold.name}` });
  await expect(skip).toBeVisible();
  await expect(panel.getByRole('button', { name: `Remove ${hold.name} from queue` })).toHaveCount(0);

  // The bytes are what make this the in-flight path rather than the queued one:
  // a file that has not started has nothing on disk, and a cancel of a row
  // whose bytes are all in is not a cancel of a transfer either. Polled on the
  // window itself rather than slept through, so the click lands early in the
  // drain where there is the most margin, and a skip that arrives after the
  // last byte fails here instead of quietly testing nothing. FILE_HOLD's
  // ~2.8s against a poll that resolves on the first sample above zero is the
  // whole margin.
  await expect
    .poll(
      async () => {
        const bytes =
          (await diskWrites(receiver)).find((write) => write.suggestedName === hold.name)?.bytes ??
          0;
        return bytes > 0 && bytes < FILE_HOLD_BYTES;
      },
      { message: 'the file in flight had written some of its bytes, and not all of them' },
    )
    .toBe(true);

  await skip.click();

  // The state the row lands in, which is the whole difference between a skip and
  // a failure. The status line beside it is deliberately not asserted: with two
  // small files queued behind, the pump has the next one saved before a poll
  // could catch it, so `Skipped <name>.` is a status that is real and
  // unreadable here, and the label is the durable form of the same claim.
  await expect(offerRow(receiver, hold.name).getByText('Cancelled', { exact: true })).toBeVisible();
  // The negative assertion the bug was about, and the reason it is written
  // against a trace of every banner the page mounted rather than left to the
  // absence of a failure below: a receiver who chose to skip a file must never
  // be told it failed. The count below is the state the pages are left in; the
  // trace is what says the banner was never raised, because the next file's
  // `runOne` clears the error on its way past and a banner that was up for one
  // frame is a banner a live count can never see.
  expect(
    await receiver.getByRole('alert').count(),
    'the receiver is showing no error banner',
  ).toBe(0);
  expect(
    await observedAlerts(receiver),
    'the receiver was never shown an error banner for the file it skipped',
  ).toEqual([]);

  // The pump carries on. The panel emptying is the wait, not a sleep, and both
  // small files were behind the one that was skipped.
  await expect(panel).toContainText('Queue (0 files)');
  await expect(panel.getByText('Nothing queued yet.')).toBeVisible();
  await expect(liveRegion(receiver)).toHaveText('Saved to disk.');

  // Three picks and two whole files: the skip left behind a record that was
  // aborted and never closed, holding fewer bytes than the file has. That is
  // the shape of a skip, and it is also why the count is three rather than two.
  const writes = await diskWrites(receiver);
  expect(writes.length, 'showSaveFilePicker invocations').toBe(3);
  const byName = new Map(writes.map((write) => [write.suggestedName ?? '', write]));
  const skipped = byName.get(hold.name);
  if (skipped === undefined) throw new Error(`nothing was written as ${hold.name}`);
  expect(skipped.closed, 'the skipped file was never closed').toBe(false);
  expect(skipped.aborted, 'the skipped file was aborted').toBe(true);
  expect(skipped.bytes, 'the skipped file stopped short of the whole file').toBeLessThan(
    FILE_HOLD_BYTES,
  );
  for (const file of [second, third]) {
    const write = byName.get(file.name);
    if (write === undefined) throw new Error(`nothing was written as ${file.name}`);
    expectWrittenAs(write, file);
  }

  // The sender's half: its row reads cancelled rather than failed, and the
  // share is untouched. Asserted before the retry below, which starts the same
  // file again and replaces the row.
  const senderRow = sender.locator('li.file-row').filter({ hasText: `Receiver 1 · ${hold.name}` });
  await expect(senderRow).toHaveCount(1);
  await expect(senderRow).toContainText('cancelled.');
  await expect(senderRow).not.toContainText('failed.');
  expect(
    await sender.getByRole('alert').count(),
    'the sender was not told the cancelled transfer had failed',
  ).toBe(0);
  expect(await observedAlerts(sender), 'the sender never showed an error banner').toEqual([]);
  expect(
    await receiver.getByRole('alert').count(),
    'the receiver banner is still down after the queue drained',
  ).toBe(0);

  // A cancelled row is not an undo. Its menu is live again, the index was
  // dequeued rather than left blocking, and the sender is still serving this
  // share -- all three are only true if the skip released what it held, and the
  // same file coming back byte for byte is what says the share survived it.
  await downloadFile(receiver, hold.name);
  const afterRetry = await diskWrites(receiver);
  expect(afterRetry.length, 'showSaveFilePicker invocations including the retry').toBe(4);
  const retried = afterRetry[3];
  if (retried === undefined) throw new Error('the retried file left no record at all');
  expect(retried.suggestedName, 'the file that was asked for again').toBe(hold.name);
  expectWrittenAs(retried, hold);
  await expect(senderRow).toContainText('delivered.');
  await expect(liveRegion(sender)).toHaveText(`Sent ${hold.name} to Receiver 1.`);
  expect(await sender.getByRole('alert').count(), 'the sender banner after the retry').toBe(0);
  expect(await receiver.getByRole('alert').count(), 'the receiver banner after the retry').toBe(0);
  expect(await observedAlerts(sender), 'the sender banner after the retry, ever').toEqual([]);
  expect(await observedAlerts(receiver), 'the receiver banner after the retry, ever').toEqual([]);

  expect(errors).toEqual([]);
  await senderContext.close();
  await receiverContext.close();
});

test('drops a receiver whose tab navigates away mid-transfer', async ({ browser }) => {
  test.skip(!LIVE, SKIP_LIVE);
  // The tab is navigated away rather than killed with context.close(). Both end
  // the page, but they do not both reach the app: a closed context tears the
  // renderer down with the transport still up, and the sender's row then stays
  // on screen indefinitely — measured here for over four minutes after the
  // browser's RTCPeerConnection had already reported iceConnectionState
  // "disconnected" at ~25s and "closed" at ~65s, because PeerJS only acts on
  // "failed" and "closed" and does not forward either to the DataConnection.
  // A tab that navigates away shuts the channel down, so this drives the path
  // the app can actually see. The abrupt-close case is pinned separately, by
  // the test annotated test.fail() below.
  test.slow();

  // FILE_HOLD, not FILE_A, so the file really is in flight when the tab goes:
  // 300KB crosses a DataChannel between peers on one machine in well under
  // 100ms, which meant the row this test removes was already `delivered.` by
  // the time the assertions above it had resolved. Mid-transfer is the harder
  // case and the one worth covering — a 60s stall timer can fire first and
  // mark the row `failed.` without removing it, which is a different code
  // path. See FILE_HOLD for the measurement.
  const file = await makeFile(FILE_HOLD, FILE_HOLD_SEED, FILE_HOLD_BYTES);
  const errors: string[] = [];

  const senderContext = await browser.newContext({
    acceptDownloads: true,
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const receiverContext = await browser.newContext({ acceptDownloads: true });
  const sender = await senderContext.newPage();
  const receiver = await receiverContext.newPage();
  await trackPageErrors(sender, 'sender', errors);
  await trackPageErrors(receiver, 'receiver', errors);
  await installDiskSink(receiver);

  const token = await startSharing(sender, [file]);
  const link = await readShareLink(sender, token);
  requireSameOriginLink(sender, link);
  await connectFromLink(receiver, link);
  await offerListed(receiver, [file.name]);

  // A row exists for the receiver before anything is transferred, so the
  // departure has something to remove.
  await queueFile(receiver, file.name);
  await expect(sender.locator('li.file-row.transfer')).toHaveCount(1);
  await expect(sender.locator('li.file-row.transfer').first()).toContainText(
    `Receiver 1 · ${file.name}`,
  );

  // The sender must stop showing the row rather than leave a progress bar frozen
  // at whatever it reached. This is a fresh page that has never stopped sharing,
  // so the receiver is Receiver 1; a page that had stopped and restarted would
  // keep counting up and label the next one Receiver 2.
  await receiver.goto('about:blank');
  await expect(sender.locator('li.file-row.transfer')).toHaveCount(0);
  await expect(sender.getByText('Waiting for a receiver...')).toBeVisible();
  // The status line names the departure because the transfer this status line
  // was about belongs to the receiver that just left. The clipboard test below
  // is only meaningful because of this one: there, a departure must NOT say
  // anything, because the status line has moved on to the clipboard.
  await expect(liveRegion(sender)).toHaveText('Receiver 1 left.');

  expect(errors).toEqual([]);
  await receiverContext.close();
  await senderContext.close();
});

test('drops a receiver whose browser dies without a clean shutdown', async ({ browser }) => {
  test.skip(!LIVE, SKIP_LIVE);
  // This is the abrupt close the test above deliberately does not drive, pinned
  // as a KNOWN FAILING test rather than described in prose. It fails today: the
  // receiver's renderer is torn down with the transport still up, PeerJS acts
  // only on `failed` and `closed` (and closes the RTCPeerConnection without
  // closing the DataConnection), PeerChannel only listens for `conn.on('close')`
  // and `conn.on('error')`, and `disconnected` is ignored — so the sender's row
  // and the receiver count stay on screen. Measured: iceConnectionState
  // "disconnected" at ~25s, "closed" at ~65s, row still there at ~265s.
  //
  // The 60s DEFAULT_STALL_TIMEOUT_MS is not the fix this is waiting for either:
  // it only runs inside an active SenderEngine, and it marks the row `failed.`
  // rather than removing it. A receiver that dies while merely browsing the
  // file list, with no engine running, is not detected at all.
  //
  // It is marked failing rather than skipped so the gap is executable: when a
  // heartbeat or a liveness detector lands, Playwright reports "expected to
  // fail but passed", which is the prompt to delete the test.fail() line. No
  // assertion here is weakened to accommodate the gap — the assertions are
  // exactly the ones the navigation test above makes.
  test.fail();
  // The wait is the bound the app is given to notice a dead peer, not the bound
  // it takes: nothing in the app today produces a signal inside it. Kept under
  // the test timeout so the failure is this assertion and not a suite error.
  test.setTimeout(ABRUPT_CLOSE_BUDGET_MS + 30_000);

  // FILE_HOLD so the death lands mid-transfer, where the sender has a row to
  // remove and a stall timer that could plausibly be mistaken for detection.
  const file = await makeFile(FILE_HOLD, FILE_HOLD_SEED, FILE_HOLD_BYTES);
  const errors: string[] = [];

  const senderContext = await browser.newContext({
    acceptDownloads: true,
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const receiverContext = await browser.newContext({ acceptDownloads: true });
  const sender = await senderContext.newPage();
  const receiver = await receiverContext.newPage();
  await trackPageErrors(sender, 'sender', errors);
  await trackPageErrors(receiver, 'receiver', errors);
  await installDiskSink(receiver);

  const token = await startSharing(sender, [file]);
  const link = await readShareLink(sender, token);
  requireSameOriginLink(sender, link);
  await connectFromLink(receiver, link);
  await offerListed(receiver, [file.name]);

  await queueFile(receiver, file.name);
  await expect(sender.locator('li.file-row.transfer')).toHaveCount(1);

  // The abrupt part: the whole browser context goes, with no navigation and no
  // close frame on the channel.
  await receiverContext.close();

  await expect(
    sender.locator('li.file-row.transfer'),
    'the sender notices a receiver that died without closing the channel',
  ).toHaveCount(0, { timeout: ABRUPT_CLOSE_BUDGET_MS });
  await expect(sender.getByText('Waiting for a receiver...')).toBeVisible();
  await expect(liveRegion(sender)).toHaveText('Receiver 1 left.');

  expect(errors).toEqual([]);
  await senderContext.close();
});

test('keeps the clipboard confirmation when a receiver leaves', async ({ browser }) => {
  test.skip(!LIVE, SKIP_LIVE);

  const file = await makeFile(FILE_A, FILE_A_SEED, FILE_A_BYTES);
  const errors: string[] = [];
  const senderContext = await browser.newContext({
    acceptDownloads: true,
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const receiverContext = await browser.newContext({ acceptDownloads: true });
  const sender = await senderContext.newPage();
  const receiver = await receiverContext.newPage();
  await trackPageErrors(sender, 'sender', errors);
  await trackPageErrors(receiver, 'receiver', errors);
  await installDiskSink(receiver);

  const token = await startSharing(sender, [file]);
  const link = await readShareLink(sender, token);
  requireSameOriginLink(sender, link);
  await connectFromLink(receiver, link);
  await offerListed(receiver, [file.name]);
  await downloadFile(receiver, file.name);
  // The copy below is only meaningful if a transfer has already happened and
  // already owned the status line, so the save is asserted rather than assumed.
  await expect(liveRegion(receiver)).toHaveText('Saved to disk.');

  // Copy AFTER a transfer, so the status line the departure might clobber is
  // the clipboard confirmation and not a transfer message.
  await sender.getByRole('button', { name: 'Copy token' }).click();
  await expect(liveRegion(sender)).toHaveText('Token copied to the clipboard.');

  // The receiver is navigated away, not closed. Both end the page, but only one
  // of them reaches the app: `copy` clears statusReceiverRef, so a departure
  // the app can see must not speak. A closed context tears the renderer down
  // with the transport still up, `onDisconnect` never fires, and this assertion
  // holds for the wrong reason — it passed with `statusReceiverRef.current =
  // null` deleted from `copy`, so it pinned nothing. Navigating away shuts the
  // channel down, and the same deletion makes it fail on
  // `Received "Receiver 1 left."`.
  await receiver.goto('about:blank');
  await expect(liveRegion(sender)).toHaveText('Token copied to the clipboard.');

  expect(errors).toEqual([]);
  await receiverContext.close();
  await senderContext.close();
});

test('moves a single encrypted file to the browser download path', async ({ browser }) => {
  test.skip(!LIVE, SKIP_LIVE);

  // The suite's build is in picker mode (see playwright.config.ts), so this is
  // the one test that takes the OTHER sink: removing showSaveFilePicker makes
  // isFileSystemAccessSupported() false at first render, canStreamToDisk goes
  // false with it, and the file lands through the browser's own download. One
  // build, both sinks.
  const file = await makeFile(FILE_A, FILE_A_SEED, FILE_A_BYTES);
  const errors: string[] = [];

  const senderContext = await browser.newContext({
    acceptDownloads: true,
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const receiverContext = await browser.newContext({ acceptDownloads: true });
  const sender = await senderContext.newPage();
  const receiver = await receiverContext.newPage();
  await trackPageErrors(sender, 'sender', errors);
  await trackPageErrors(receiver, 'receiver', errors);
  await removeDiskSink(receiver);
  const receiverTrace = traceWire(receiver);

  const token = await startSharing(sender, [file]);
  const link = await readShareLink(sender, token);
  requireSameOriginLink(sender, link);

  await connectFromLink(receiver, link);
  await expect(receiver.getByText('1 file is on offer.')).toBeVisible();
  await offerListed(receiver, [file.name]);

  const downloadPromise = receiver.waitForEvent('download');
  await downloadFile(receiver, file.name);
  await expect(liveRegion(receiver)).toHaveText('Download started.');
  expect(await receiver.getByRole('alert').count(), 'the receiver reported an error').toBe(0);

  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(file.name);
  const saved = await download.path();
  expect(saved).not.toBeNull();
  const received = await readFile(saved as string);
  expect(received.length).toBe(file.bytes.length);
  expect(sha256(received)).toBe(sha256(file.bytes));
  expect(received.equals(file.bytes)).toBe(true);

  expect(await leakReport(receiver, token)).toEqual([]);
  expect(
    await wireLeakReport(receiverTrace.wire, receiverTrace.bodies, token),
    'every request and WebSocket the receiver opened',
  ).toEqual([]);
  expect(
    receiverTrace.wire.some((url) => url.startsWith('wss://')),
    'the receiver opened a signalling socket, so the wire trace saw more than asset loads',
  ).toBe(true);
  expect(errors).toEqual([]);

  await senderContext.close();
  await receiverContext.close();
});

test('streams to disk when the picker returns a file handle', async ({ browser }) => {
  test.skip(!LIVE, SKIP_LIVE);

  // Some Chrome builds resolve showSaveFilePicker with a FileSystemFileHandle
  // rather than a stream. The stream comes from createWritable(), and the file
  // must still land on disk.
  const file = await makeFile(FILE_A, FILE_A_SEED, FILE_A_BYTES);
  const errors: string[] = [];

  const senderContext = await browser.newContext({
    acceptDownloads: true,
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const receiverContext = await browser.newContext({ acceptDownloads: true });
  const sender = await senderContext.newPage();
  const receiver = await receiverContext.newPage();
  await trackPageErrors(sender, 'sender', errors);
  await trackPageErrors(receiver, 'receiver', errors);
  await installHandleShapedPicker(receiver);

  const token = await startSharing(sender, [file]);
  const link = await readShareLink(sender, token);
  requireSameOriginLink(sender, link);

  await connectFromLink(receiver, link);
  await offerListed(receiver, [file.name]);

  await downloadFile(receiver, file.name);
  await expect(liveRegion(receiver)).toHaveText('Saved to disk.');
  expect(await receiver.getByRole('alert').count(), 'the receiver reported an error').toBe(0);

  const base64 = await receiver.evaluate(() => {
    const disk = window.__e2eDisk;
    if (disk === undefined) throw new Error('the disk probe was never installed');
    const record = disk.files[0];
    if (record === undefined) throw new Error('createWritable was never reached');
    return record.read();
  });
  expect(Buffer.from(base64, 'base64').equals(file.bytes)).toBe(true);
  expect(errors).toEqual([]);

  await senderContext.close();
  await receiverContext.close();
});

test('tells the receiver when the sender stops sharing', async ({ browser }) => {
  test.skip(!LIVE, SKIP_LIVE);

  // The receiver is sitting on the file list with nothing downloading. It has
  // to notice the sender leaving rather than waiting forever.
  const files = [
    await makeFile(FILE_A, FILE_A_SEED, FILE_A_BYTES),
    await makeFile(FILE_B, FILE_B_SEED, FILE_B_BYTES),
  ];
  const errors: string[] = [];

  const senderContext = await browser.newContext({
    acceptDownloads: true,
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const receiverContext = await browser.newContext({ acceptDownloads: true });
  const sender = await senderContext.newPage();
  const receiver = await receiverContext.newPage();
  await trackPageErrors(sender, 'sender', errors);
  await trackPageErrors(receiver, 'receiver', errors);
  await installDiskSink(receiver);

  const token = await startSharing(sender, files);
  const link = await readShareLink(sender, token);
  requireSameOriginLink(sender, link);

  await connectFromLink(receiver, link);
  await offerListed(receiver, files.map((file) => file.name));

  // The sender stops sharing while the receiver still has files to take.
  await sender.getByRole('button', { name: 'Stop sharing' }).click();

  await expect(liveRegion(receiver)).toHaveText('The sender disconnected, so no more files can be taken.');
  // The only way to ask for a file is the row's menu, so a disabled trigger is
  // what "no more files can be taken" looks like on a row.
  for (const file of files) {
    await expect(
      offerRow(receiver, file.name).getByRole('button', { name: `More actions for ${file.name}` }),
      'no file can be requested once the sender has gone',
    ).toBeDisabled();
  }
  expect(errors).toEqual([]);

  await senderContext.close();
  await receiverContext.close();
});

test('connects on the default selection and names the default relay in the token', async ({ browser }) => {
  test.skip(!LIVE, SKIP_LIVE);

  const file = await makeFile(FILE_A, FILE_A_SEED, FILE_A_BYTES);
  const errors: string[] = [];
  const senderContext = await browser.newContext({
    acceptDownloads: true,
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const receiverContext = await browser.newContext({ acceptDownloads: true });
  const sender = await senderContext.newPage();
  const receiver = await receiverContext.newPage();
  await trackPageErrors(sender, 'sender', errors);
  await trackPageErrors(receiver, 'receiver', errors);
  await installDiskSink(receiver);

  await sender.goto('/');
  await sender.getByLabel('Choose files to share').setInputFiles([file.path]);
  await openPicker(sender);

  // The default is the behaviour the app shipped with, and the regression that
  // would matter is a default that no longer connects - so the state of the
  // controls is asserted and then actually used, with nothing changed between
  // the two. A picker left at the default is what carries this file.
  expect(await selectionIn(sender), 'the selection being shared on').toEqual({
    enabled: [STUN_INDEX, EU_RELAY_INDEX, US_RELAY_INDEX],
    relay: EU_RELAY_INDEX,
  });
  await expect(deviationLine(sender), 'nothing has been changed from the default').toHaveCount(0);

  // startSharing asserts the token's pattern and its length, so a drifting
  // encoder goes red here rather than in a test about something else.
  const token = await startSharing(sender, [file]);
  expect(relayOf(token), 'the token names the designated relay').toBe(EU_RELAY_INDEX);
  const link = await readShareLink(sender, token);
  requireSameOriginLink(sender, link);

  await connectFromLink(receiver, link);
  await offerListed(receiver, [file.name]);
  await downloadFile(receiver, file.name);
  await expect(liveRegion(receiver)).toHaveText('Saved to disk.');
  const written = (await diskWrites(receiver))[0];
  if (written === undefined) throw new Error('nothing was written at all');
  expectWrittenAs(written, file);
  expect(errors).toEqual([]);

  await senderContext.close();
  await receiverContext.close();
});

test('accepts a token naming relay index zero and a 54-byte token with no relay byte', async ({ browser }) => {
  test.skip(!LIVE, SKIP_LIVE);
  // One sender, two receivers, two connections and two transfers over a public
  // broker: past the default budget on a slow run, as the queue tests are.
  test.slow();

  const file = await makeFile(FILE_A, FILE_A_SEED, FILE_A_BYTES);
  const errors: string[] = [];
  const senderContext = await browser.newContext({
    acceptDownloads: true,
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const sender = await senderContext.newPage();
  await trackPageErrors(sender, 'sender', errors);

  const token = await startSharing(sender, [file]);
  const link = await readShareLink(sender, token);
  requireSameOriginLink(sender, link);
  // readShareLink has just checked the link is same-origin, so its origin and
  // path are safe to keep: only the fragment is replaced below.
  const base = new URL(link);

  // Both forged tokens keep the sender's room code and key, so each one points
  // at a sender that is really hosting; only the relay byte differs.
  const cases = [
    {
      label: 'a token naming relay index zero',
      forged: tokenWithRelay(token, STUN_INDEX),
      relay: STUN_INDEX,
      // 55 bytes: 54 plus the relay byte.
      length: TOKEN_LENGTH,
    },
    {
      label: 'a 54-byte token with no relay byte',
      forged: tokenWithRelay(token, null),
      relay: null,
      // 54 bytes, so one data character shorter than a token that names a relay.
      length: TOKEN_LENGTH - 1,
    },
  ] as const;

  for (const entry of cases) {
    // The forgery is checked here, in the test's own terms, so a case cannot go
    // green because the token it built was not the one it meant to build.
    expect(relayOf(entry.forged), `${entry.label}: the relay byte`).toBe(entry.relay);
    expect(entry.forged.length, `${entry.label}: the length`).toBe(entry.length);
    expect(
      roomIdOf(entry.forged),
      `${entry.label}: it still names the room the sender is hosting`,
    ).toBe(roomIdOf(token));

    const receiverContext = await browser.newContext({ acceptDownloads: true });
    const receiver = await receiverContext.newPage();
    await trackPageErrors(receiver, 'receiver', errors);
    await installDiskSink(receiver);

    await connectFromLink(receiver, `${base.origin}${base.pathname}#${entry.forged}`);
    await offerListed(receiver, [file.name]);
    await downloadFile(receiver, file.name);
    await expect(liveRegion(receiver)).toHaveText('Saved to disk.');
    // A token naming a server that cannot relay is still a token. The codec
    // deliberately does not consult the table, and an index it cannot honour
    // goes to the default relay rather than failing the link, so the receiver
    // has to accept this one quietly rather than say anything.
    //
    // Index 0 is also the only falsy relay index anywhere, which is what makes
    // `payload.relay ?? DEFAULT_RELAY` the right operator: `||` would have
    // replaced 0 with DEFAULT_RELAY first, and since resolveRelay(0) resolves
    // to that same entry the config the receiver gathers from is identical
    // either way. So this cannot observe the operator, and does not claim to.
    // What it does pin is the part that is observable - that a 55-byte token
    // carrying 0 is accepted at all, rather than refused as a malformed link,
    // and that the transfer it names still works end to end.
    await expect(receiver.getByRole('alert'), `${entry.label}: the receiver did not complain`)
      .toHaveCount(0);
    const written = (await diskWrites(receiver))[0];
    if (written === undefined) throw new Error(`nothing was written for ${entry.label}`);
    expectWrittenAs(written, file);

    await receiverContext.close();
  }

  expect(errors).toEqual([]);
  await senderContext.close();
});

test('gives the receiver the default servers whatever the sender switches off', async ({ browser }) => {
  test.skip(!LIVE, SKIP_LIVE);

  // The picker's least obvious property, and the one its own copy spends a
  // paragraph on: a checkbox changes what this browser tries and nothing about
  // what the receiver tries, because PeerSession.join hardcodes the default for
  // everything except the relay the token names. Reading the controls cannot
  // show that - it takes the config each side actually built.
  const file = await makeFile(FILE_A, FILE_A_SEED, FILE_A_BYTES);
  const errors: string[] = [];
  const senderContext = await browser.newContext({
    acceptDownloads: true,
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const receiverContext = await browser.newContext({ acceptDownloads: true });
  const sender = await senderContext.newPage();
  const receiver = await receiverContext.newPage();
  await trackPageErrors(sender, 'sender', errors);
  await trackPageErrors(receiver, 'receiver', errors);
  await installDiskSink(receiver);
  await spyOnPeerConnections(sender);
  await spyOnPeerConnections(receiver);

  await sender.goto('/');
  await sender.getByLabel('Choose files to share').setInputFiles([file.path]);
  await openPicker(sender);
  await serverCheckbox(sender, STUN_INDEX).uncheck();
  expect(await selectionIn(sender), 'the sender switched its own discovery off').toEqual({
    enabled: [EU_RELAY_INDEX, US_RELAY_INDEX],
    relay: EU_RELAY_INDEX,
  });

  // The token carries the relay index and nothing else about the selection, so
  // a switched-off STUN entry cannot have left a trace in it.
  const token = await startSharing(sender, [file]);
  expect(relayOf(token), 'the token still names the designated relay').toBe(EU_RELAY_INDEX);
  const link = await readShareLink(sender, token);
  requireSameOriginLink(sender, link);

  await connectFromLink(receiver, link);
  await offerListed(receiver, [file.name]);
  await downloadFile(receiver, file.name);
  await expect(liveRegion(receiver)).toHaveText('Saved to disk.');

  const senderIce = await iceConfigs(sender);
  const receiverIce = await iceConfigs(receiver);
  const bothRelays = [...BOTH_RELAY_URLS].sort();
  expect(
    senderIce,
    'the sender gathered from the two relays it was left with, and from no STUN server',
  ).toContainEqual(bothRelays);
  expect(
    receiverIce,
    'the receiver gathered from all three servers, the STUN entry included',
  ).toContainEqual([...ALL_STUN_URLS, ...BOTH_RELAY_URLS].sort());
  expect(receiverIce, "the sender's choice did not reach the receiver").not.toContainEqual(bothRelays);
  expect(errors).toEqual([]);

  await senderContext.close();
  await receiverContext.close();
});
