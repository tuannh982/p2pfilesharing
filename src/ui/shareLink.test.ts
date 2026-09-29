import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeShare } from '../token/codec';
import { mintSharePayload } from '../token/mint';
import { buildShareLink, readTokenFromFragment, shareTokenFrom } from './shareLink';

const TOKEN = `p2fs1${'q'.repeat(87)}`;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('shareTokenFrom', () => {
  it('accepts a bare token', () => {
    expect(shareTokenFrom(TOKEN)).toBe(TOKEN);
  });

  it('accepts a token pasted with surrounding whitespace', () => {
    expect(shareTokenFrom(`  ${TOKEN}\n`)).toBe(TOKEN);
  });

  it('accepts a full share link and returns just the token', () => {
    expect(shareTokenFrom(`https://send.example/#${TOKEN}`)).toBe(TOKEN);
  });

  it('returns an empty string for an empty paste', () => {
    expect(shareTokenFrom('   ')).toBe('');
  });

  it('passes through a non-token paste so decodeShare can explain it', () => {
    expect(shareTokenFrom('nonsense')).toBe('nonsense');
  });

  it('passes through a URL whose fragment holds no token', () => {
    expect(shareTokenFrom('https://send.example/#section-two')).toBe('https://send.example/#section-two');
  });

  it('canonicalises an uppercase bare paste to the lowercase token', () => {
    expect(shareTokenFrom(TOKEN.toUpperCase())).toBe(TOKEN);
  });
});

describe('buildShareLink', () => {
  it('puts the token in the fragment of the given base url', () => {
    expect(buildShareLink(TOKEN, 'https://send.example/')).toBe(`https://send.example/#${TOKEN}`);
  });

  it('keeps a base path, so a subpath deployment still works', () => {
    expect(buildShareLink(TOKEN, 'https://send.example/app/')).toBe(
      `https://send.example/app/#${TOKEN}`,
    );
  });

  it('replaces an existing fragment rather than appending a second one', () => {
    expect(buildShareLink(TOKEN, 'https://send.example/#old')).toBe(
      `https://send.example/#${TOKEN}`,
    );
  });

  it('produces a link that stays well under 200 characters', () => {
    expect(buildShareLink(TOKEN, 'https://send.example/').length).toBeLessThan(200);
  });

  it('uses the fragment, never a query parameter', () => {
    expect(buildShareLink(TOKEN, 'https://send.example/')).not.toContain('?');
  });

  it('falls back to the VITE_APP_URL override when no base is given', async () => {
    vi.stubEnv('VITE_APP_URL', 'https://share.example/app/');
    vi.resetModules();
    const { buildShareLink: withOverride } = await import('./shareLink');
    expect(withOverride(TOKEN)).toBe(`https://share.example/app/#${TOKEN}`);
  });

  it('prefers an explicit base over the VITE_APP_URL override', async () => {
    vi.stubEnv('VITE_APP_URL', 'https://share.example/app/');
    vi.resetModules();
    const { buildShareLink: withOverride } = await import('./shareLink');
    expect(withOverride(TOKEN, 'https://send.example/')).toBe(`https://send.example/#${TOKEN}`);
  });

  it('falls back to the current page when VITE_APP_URL is not a url', async () => {
    vi.stubEnv('VITE_APP_URL', 'not a url');
    vi.resetModules();
    vi.stubGlobal('window', { location: { origin: 'https://send.example', pathname: '/app/' } });
    const { buildShareLink: withBroken } = await import('./shareLink');
    expect(withBroken(TOKEN)).toBe(`https://send.example/app/#${TOKEN}`);
  });

  it('falls back to the current page when the given base is not a url', async () => {
    vi.stubEnv('VITE_APP_URL', undefined);
    vi.resetModules();
    vi.stubGlobal('window', { location: { origin: 'https://send.example', pathname: '/app/' } });
    const { buildShareLink: withBroken } = await import('./shareLink');
    expect(withBroken(TOKEN, 'nonsense')).toBe(`https://send.example/app/#${TOKEN}`);
  });
});

describe('readTokenFromFragment', () => {
  it('reads a token out of a share link', () => {
    expect(readTokenFromFragment(`https://send.example/#${TOKEN}`)).toBe(TOKEN);
  });

  it('reads a percent-encoded token out of the fragment', () => {
    const percentEncoded = [...TOKEN]
      .map((char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`)
      .join('');
    expect(percentEncoded).not.toBe(TOKEN);
    expect(readTokenFromFragment(`https://send.example/#${percentEncoded}`)).toBe(TOKEN);
  });

  it('returns nothing when the url carries no fragment', () => {
    expect(readTokenFromFragment('https://send.example/')).toBe('');
  });

  it('returns nothing when the fragment is not a token', () => {
    expect(readTokenFromFragment('https://send.example/#section-two')).toBe('');
  });

  it('never reads a token from a query parameter, which the server would see', () => {
    expect(readTokenFromFragment(`https://send.example/?s=${TOKEN}`)).toBe('');
  });

  it('returns nothing rather than throwing on an unparseable href', () => {
    expect(readTokenFromFragment('not a url')).toBe('');
  });

  it('canonicalises an uppercase token in the fragment to the lowercase token', () => {
    expect(readTokenFromFragment(`https://send.example/#${TOKEN.toUpperCase()}`)).toBe(TOKEN);
  });
});

describe('share link round trip', () => {
  it('reads back exactly the token that built the link', async () => {
    const token = encodeShare(await mintSharePayload());
    expect(shareTokenFrom(buildShareLink(token, 'https://send.example/'))).toBe(token);
  });

  it('reads back the token when the base already carries a query string', async () => {
    const token = encodeShare(await mintSharePayload());
    const link = buildShareLink(token, 'https://host/app/?theme=dark');
    expect(link).toBe(`https://host/app/?theme=dark#${token}`);
    expect(shareTokenFrom(link)).toBe(token);
  });

  it('reads back the lowercase token from an uppercase link', async () => {
    const token = encodeShare(await mintSharePayload());
    expect(shareTokenFrom(buildShareLink(token.toUpperCase(), 'https://send.example/'))).toBe(token);
  });
});
