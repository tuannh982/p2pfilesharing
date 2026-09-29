import { APP_URL } from '../config/network';

const FRAGMENT = '#';
const TOKEN_PATTERN = /^p2fs1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]+$/i;

const isToken = (value: string): boolean => TOKEN_PATTERN.test(value);

const fragmentToken = (href: string): string => {
  try {
    const hash = new URL(href).hash;
    const fragment = decodeURIComponent(hash.slice(FRAGMENT.length)).trim();
    return isToken(fragment) ? fragment.toLowerCase() : '';
  } catch {
    return '';
  }
};

export function readTokenFromFragment(href: string): string {
  return fragmentToken(href);
}

export function shareTokenFrom(input: string): string {
  const trimmed = input.trim();
  if (trimmed === '') return '';
  if (isToken(trimmed)) return trimmed.toLowerCase();
  if (trimmed.toLowerCase().startsWith('http')) {
    const fromFragment = fragmentToken(trimmed);
    if (fromFragment !== '') return fromFragment;
  }
  return trimmed;
}

const parseUrl = (value: string | null | undefined): URL | null => {
  if (value === undefined || value === null) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

const pageUrl = (): string => `${window.location.origin}${window.location.pathname}`;

export function buildShareLink(token: string, base: string | null = null): string {
  const url = parseUrl(base) ?? parseUrl(APP_URL) ?? new URL(pageUrl());
  url.hash = `${FRAGMENT}${token}`;
  return url.toString();
}
