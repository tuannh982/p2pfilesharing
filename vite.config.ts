import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => {
  // A GitHub Pages project site is served from https://<user>.github.io/<repo>/,
  // so assets referenced as /assets/... would 404 without the base path. A user
  // or organisation site is served from the root and needs none. Set VITE_BASE
  // explicitly (or leave it unset for a root deploy) to override the guess.
  const explicit = process.env['VITE_BASE'];
  const base = explicit ?? (mode === 'gh-pages' ? guessProjectBase() : '/');

  return {
    base,
    plugins: [react()],
  };
});

function guessProjectBase(): string {
  const url = process.env['GITHUB_REPOSITORY'];
  if (url === undefined || url === '') return '/';
  const repo = url.split('/')[1];
  if (repo === undefined || repo === '') return '/';
  return repo.endsWith('.github.io') ? '/' : `/${repo}/`;
}
