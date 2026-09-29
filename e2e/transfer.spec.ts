/// <reference types="node" />
import { bech32m } from 'bech32';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { expect, test, type Locator, type Page } from '@playwright/test';

const LIVE = process.env['E2E_LIVE'] === '1';
const SKIP_LIVE = 'set E2E_LIVE=1 to run the networked test';

const FILE_A = 'e2e-share-a.bin';
const FILE_A_SEED = 0x2f6e2b1;
const FILE_A_BYTES = 300 * 1024;

const FILE_B = 'e2e-share-b.bin';
const FILE_B_SEED = 0x13a5f27;
const FILE_B_BYTES = 150 * 1024;

const TOKEN_PATTERN = /^p2fs1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]+$/;

// roomIdLen(1) | roomId(20) | keyLen(1) | key(32) = 54 bytes, which bech32m
// packs into 87 data characters plus a 6 character checksum, behind the
// "p2fs1" human readable part: 98 characters, every time.
const TOKEN_LENGTH = 98;

const REJECT_BUDGET_MS = 5_000;

// How long the mid-start test waits for the broker socket to appear. The public
// broker answers in well under a second in practice; this is the ceiling before
// the test declares the round trip never started.
const BROKER_SOCKET_MS = 15_000;

// Token-shaped but not a real token: the checksum does not verify, so the
// Receiving tab reports it as unreadable while still rendering the field.
const FAKE_TOKEN = `p2fs1${'q'.repeat(87)}`;

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
  }
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

async function downloadFile(page: Page, name: string): Promise<void> {
  const row = fileRow(page, name);
  const button = row.getByRole('button', { name: `Download ${name}` });
  await expect(button).toBeEnabled();
  await button.click();
  const saved = row.getByRole('button', { name: `Download again ${name}` });
  await expect(saved).toBeVisible();
  await expect(saved).toHaveText('Download again');
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

  const first = await makeFile(FILE_A, FILE_A_SEED, FILE_A_BYTES);
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

  // One at a time, on the same channel: the first transfer has to finish
  // before the second row's button is clickable again. The second row is still
  // Waiting rather than Downloading, and has mounted no progress bar, so this
  // distinguishes the two states the button's text alone cannot.
  await downloadFile(receiver, first.name);
  await expect(liveRegion(receiver)).toHaveText('Saved to disk.');
  const secondRow = fileRow(receiver, second.name);
  await expect(secondRow.getByText('Waiting', { exact: true })).toBeVisible();
  await expect(secondRow.locator('progress')).toHaveCount(0);
  expect(await observedRowProgress(receiver), 'the second file has not started').not.toContain(
    `Downloading ${second.name}`,
  );

  await downloadFile(receiver, second.name);
  // The status line still reads "Saved to disk." because it is the one line for
  // the whole share, so re-asserting it here would prove nothing. The
  // second-file-specific facts are its own row and the progress it reported.
  const secondSaved = secondRow.getByRole('button', { name: `Download again ${second.name}` });
  await expect(secondSaved).toBeEnabled();
  expect(
    await observedRowProgress(receiver),
    'the second file reported progress of its own',
  ).toContain(`Downloading ${second.name}`);

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
  await expect(liveRegion(sender)).toHaveText(`Receiver 1 delivered ${second.name}.`);

  const progress = await observedRowProgress(receiver);
  expect(progress, 'the receiving rows reported progress').toContain(`Downloading ${first.name}`);
  expect(progress, 'the receiving rows reported progress').toContain(`Downloading ${second.name}`);

  // What is asserted here is only that the row stops offering a second
  // A saved file offers to be taken again. Re-serving it repeats the nonce,
  // but repeats the plaintext with it, so it hands the peer nothing new.
  const replay = fileRow(receiver, first.name).getByRole('button', {
    name: `Download again ${first.name}`,
  });
  await expect(replay).toBeEnabled();

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

test('moves a single encrypted file to the browser download path', async ({ browser }) => {
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
  await expect(
    fileRow(receiver, files[0]!.name).getByRole('button', { name: `Download ${files[0]!.name}` }),
    'no file can be requested once the sender has gone',
  ).toBeDisabled();
  expect(errors).toEqual([]);

  await senderContext.close();
  await receiverContext.close();
});
