#!/usr/bin/env bash
# Brings upstream's engine into crates/chimera with a three-way merge, so that local patches survive.
#
# usage: scripts/sync-upstream.sh
#   UPSTREAM_URL     defaults to upstream's GitHub repository
#   UPSTREAM_BRANCH  defaults to main
#
# Stops on a conflict with the merge in progress: resolve it, then `git commit`.
# Any engine change moves the sound, so run the evaluation afterwards and record a new baseline.
set -euo pipefail

prefix=crates/chimera
dictionary=public/data/cmudict.txt.gz
url=${UPSTREAM_URL:-https://github.com/jamesondh/chimera-vocal-synth.git}
branch=${UPSTREAM_BRANCH:-main}

cd "$(git rev-parse --show-toplevel)"

if [[ -n $(git status --porcelain) ]]; then
  echo "The working tree has changes: commit or stash them first." >&2
  exit 1
fi

git fetch --quiet "$url" "$branch"
upstream=$(git rev-parse FETCH_HEAD)
short=$(git rev-parse --short "$upstream")

# Splitting is deterministic, so the same upstream history always gives the same commits.
split=$(git subtree split --quiet --prefix="$prefix" "$upstream")
current=$(git log -1 --grep="^git-subtree-dir: $prefix\$" --format=%b | sed -n 's/^git-subtree-split: //p')

if [[ $split == "$current" ]]; then
  echo "Engine already at upstream $short."
else
  echo "Upstream engine changes:"
  git log --oneline "$current..$split" | head -n 40
  if ! git subtree merge --quiet --squash --prefix="$prefix" -m "Sync engine with upstream $short" "$split"; then
    echo "Conflict with a local engine patch: resolve it, then run git commit." >&2
    exit 1
  fi
  echo "Merged. Check it, run the evaluation, record a new baseline."
fi

# The engine's tests read the dictionary from outside the crate, so it is carried along.
if [[ $(git rev-parse "$upstream:$dictionary") != $(git rev-parse "HEAD:$dictionary") ]]; then
  git show "$upstream:$dictionary" >"$dictionary"
  git add "$dictionary"
  git commit --quiet -m "Sync pronunciation dictionary with upstream $short"
  echo "Dictionary updated."
fi
