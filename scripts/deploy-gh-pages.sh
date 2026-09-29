#!/usr/bin/env bash
# Build the site and publish it to the gh-pages branch.
#
#   npm run deploy              # guess the base path from the origin remote
#   VITE_BASE=/repo/ npm run deploy
#   VITE_APP_URL=https://send.example npm run deploy
#
# GitHub Pages must have "Deploy from a branch" set to gh-pages / (root).
set -euo pipefail

cd "$(dirname "$0")/.."

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "error: not a git repository." >&2
  exit 1
fi

if ! command -v npx >/dev/null 2>&1; then
  echo "error: npx is required to run vite." >&2
  exit 1
fi

remote="${DEPLOY_REMOTE:-origin}"
if ! git remote get-url "$remote" >/dev/null 2>&1; then
  echo "error: no git remote named '$remote'." >&2
  echo "       add one, or set DEPLOY_REMOTE to an existing remote." >&2
  exit 1
fi

url="$(git remote get-url "$remote")"

# The base path is the part people get wrong: a project site is served from
# /<repo>/, so assets referenced from the root would 404. Prefer an explicit
# VITE_BASE, then GITHUB_REPOSITORY (set by Actions), then the remote URL.
if [ -n "${VITE_BASE:-}" ]; then
  :
elif [ -n "${GITHUB_REPOSITORY:-}" ]; then
  slug="${GITHUB_REPOSITORY##*/}"
  case "$slug" in
    *.github.io) VITE_BASE="/" ;;
    *) VITE_BASE="/$slug/" ;;
  esac
else
  slug="${url##*/}"
  slug="${slug%.git}"
  slug="${slug##*:}"
  case "$slug" in
    github.com|gitlab.com|bitbucket.org|"") VITE_BASE="/" ;;
    *.github.io) VITE_BASE="/" ;;
    git@*|ssh://*|http://*|https://*) VITE_BASE="/" ;;
    *) VITE_BASE="/$slug/" ;;
  esac
fi
export VITE_BASE

echo "==> typechecking and building"
npx tsc -p tsconfig.json --noEmit
npx tsc -p tsconfig.node.json --noEmit
npx vite build --mode gh-pages

# Pages serves index.html for directory requests, but a stale copy from a
# previous deploy is not removed on its own, so clear the branch each time.
worktree="$(mktemp -d)"
trap 'git worktree remove --force "$worktree" >/dev/null 2>&1 || rm -rf "$worktree"' EXIT

# Always start from what the remote actually has, not from a local gh-pages,
# which may be stale or left over from a previous run.
if git fetch --quiet "$remote" gh-pages 2>/dev/null; then
  git worktree add --detach "$worktree" FETCH_HEAD >/dev/null
else
  # First deploy: start the branch from nothing rather than from main, so the
  # published site carries only the build output.
  git worktree add --detach "$worktree" >/dev/null
  git -C "$worktree" switch --orphan gh-pages >/dev/null
fi

# Clear whatever the previous deploy left behind, then copy the build in. Only
# the copied files are tracked, so the site's own .git is never removed.
find "$worktree" -mindepth 1 -not -name '.git' -maxdepth 1 -exec rm -rf {} +
cp -R "$PWD/dist/." "$worktree/"
touch "$worktree/.nojekyll"

git -C "$worktree" add -A
if git -C "$worktree" diff --cached --quiet; then
  echo "==> nothing to publish, gh-pages is already up to date"
  exit 0
fi
git -C "$worktree" commit -q -m "Deploy"

git -C "$worktree" push "$remote" HEAD:refs/heads/gh-pages --force
echo "==> published to $url (gh-pages)"
