#!/usr/bin/env bash
# Give a fresh worktree the .env.local it cannot get from git.
#
# `.env.local` is gitignored, so a new t3 worktree starts without the Clerk keys
# and CONVEX_* URLs Next.js reads, and the app fails at boot for a reason that
# looks nothing like "the file is missing". This copies the main checkout's copy
# in, and t3.json runs it on worktree create.
#
# The source is found through git rather than hardcoded: --git-common-dir points
# at the main checkout's .git from inside any worktree, so this keeps working if
# the repo moves.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -f .env.local ]; then
  echo ".env.local already here — leaving it alone."
  exit 0
fi

main_checkout="$(dirname "$(cd "$(git rev-parse --git-common-dir)" && pwd)")"
source_env="$main_checkout/.env.local"

if [ "$main_checkout" = "$(pwd)" ]; then
  echo "This is the main checkout, nothing to copy from."
  exit 0
fi

if [ ! -f "$source_env" ]; then
  echo "No .env.local in $main_checkout — copy one there first (see .env.example)." >&2
  exit 1
fi

cp "$source_env" .env.local
echo "Copied .env.local from $main_checkout"
