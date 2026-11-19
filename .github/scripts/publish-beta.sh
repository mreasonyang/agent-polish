#!/usr/bin/env bash
set -euo pipefail

version=${RELEASE_TAG#v}
filename="kyun.si-codex-polish-$version.tgz"
archive="$RUNNER_TEMP/npm-beta/$filename"
registry='https://registry.npmjs.org/@kyun.si%2fcodex-polish'
release="$GITHUB_API_URL/repos/$GITHUB_REPOSITORY/releases/tags/$RELEASE_TAG"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

fail() { echo "$*" >&2; exit 1; }

# An annotated tag also has a peeled commit. Lightweight tags point to the commit directly.
tag_commit=$(git ls-remote --exit-code origin "refs/tags/$RELEASE_TAG" "refs/tags/$RELEASE_TAG^{}" | tail -n 1 | cut -f1)
[[ "$tag_commit" == "$SOURCE_SHA" ]] || fail "The tag no longer points to the tested commit."

qualified_archive=$archive
use_archive() {
  archive=$1
  expected_integrity="sha512-$(openssl dgst -sha512 -binary "$archive" | openssl base64 -A)"
  expected_digest="sha256:$(sha256sum "$archive" | cut -d' ' -f1)"
}
use_archive "$qualified_archive"

# Different gzip implementations can encode the exact same tar differently.
# Compare the complete tar streams (including paths, modes and headers)
# before reusing an archive users can already download.
use_existing_archive() {
  local candidate=$1
  gzip -dc "$qualified_archive" > "$work/qualified.tar"
  gzip -dc "$candidate" > "$work/existing.tar"
  cmp -s "$work/qualified.tar" "$work/existing.tar" || fail "Existing archive differs from the tested tar."
  use_archive "$candidate"
}

# A missing resource is valid before the first release. Other HTTP errors are fatal.
fetch_json() {
  local url=$1 output=$2 status
  shift 2
  status=$(curl -sS --retry 2 --connect-timeout 10 --max-time 30 "$@" -o "$output" -w '%{http_code}' "$url")
  case "$status" in
    200) jq -e 'type == "object"' "$output" > /dev/null ;;
    404) echo '{}' > "$output" ;;
    *) fail "HTTP $status from $url" ;;
  esac
}

inspect_release() {
  fetch_json "$release" "$work/github.json" -H "Authorization: Bearer $GH_TOKEN"
  has_release=false
  has_asset=false
  if jq -e 'has("id")' "$work/github.json" > /dev/null; then
    has_release=true
    jq -e --arg tag "$RELEASE_TAG" '.tag_name == $tag and .prerelease and (.draft | not)' "$work/github.json" > /dev/null ||
      fail "The existing GitHub release is not a published prerelease for $RELEASE_TAG."
    if jq -e --arg name "$filename" '.assets | any(.name == $name)' "$work/github.json" > /dev/null; then
      has_asset=true
      local digest
      digest=$(jq -er --arg name "$filename" '.assets[] | select(.name == $name and .state == "uploaded") | .digest' "$work/github.json")
      if [[ "$digest" != "$expected_digest" && ${1:-} == reuse ]]; then
        mkdir -p "$work/github"
        gh release download "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" --pattern "$filename" --dir "$work/github"
        use_existing_archive "$work/github/$filename"
      fi
      [[ "$expected_digest" == "$digest" ]] || fail "The existing GitHub release asset checksum differs."
    fi
  fi
}

inspect_release reuse
nonce="$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
tags='https://registry.npmjs.org/-/package/@kyun.si%2fcodex-polish/dist-tags'
fetch_json "$tags?verify=$nonce-before" "$work/tags.json"
fetch_json "$registry/$version?verify=$nonce-before" "$work/version.json"
expected_latest=$(jq -r '.latest // empty' "$work/tags.json")
beta_before=$(jq -r '.beta // empty' "$work/tags.json")
integrity_before=$(jq -r '.dist.integrity // empty' "$work/version.json")
expected_beta=$version

if [[ -n "$beta_before" && "$beta_before" != "$version" ]]; then
  number='(0|[1-9][0-9]*)'
  [[ "$beta_before" =~ ^${number}\.${number}\.${number}-beta\.${number}$ ]] || fail "Unexpected npm beta tag: $beta_before"
  if [[ $(printf '%s\n%s\n' "$version" "$beta_before" | sort -V | tail -n 1) == "$beta_before" ]]; then
    [[ -n "$integrity_before" ]] || fail "Publishing $version would roll back the npm beta tag from $beta_before."
    expected_beta=$beta_before
  fi
fi

if jq -e --arg v "$version" '.version == $v' "$work/version.json" > /dev/null; then
  if ! "$has_asset" && [[ "$integrity_before" != "$expected_integrity" ]]; then
    mkdir -p "$work/npm"
    curl -fsS --retry 2 "https://registry.npmjs.org/@kyun.si/codex-polish/-/codex-polish-$version.tgz" -o "$work/npm/$filename"
    use_existing_archive "$work/npm/$filename"
  fi
  [[ "$integrity_before" == "$expected_integrity" ]] || fail "Published version $version has different contents."
else
  npm publish "$archive" --registry=https://registry.npmjs.org/ --tag beta --access public --provenance --ignore-scripts
fi

# npm can return success while a new package is still being processed.
deadline=$((SECONDS + 900))
tag_repaired=false
for ((attempt = 1; ; attempt++)); do
  query="verify=$nonce-after-$attempt"
  fetch_json "$registry/$version?$query" "$work/version.json"
  fetch_json "$tags?$query" "$work/tags.json"
  beta=$(jq -r '.beta // empty' "$work/tags.json")
  latest=$(jq -r '.latest // empty' "$work/tags.json")
  if [[ $(jq -r '.dist.integrity' "$work/version.json") == "$expected_integrity" && "$beta" == "$expected_beta" ]]; then
    if [[ "$latest" == "$version" && "$beta" == "$version" ]] && ! "$tag_repaired"; then
      # npm sometimes assigns latest to the first real version even with --tag beta.
      # Only remove it when the registry has never contained a stable release.
      fetch_json "$registry?$query" "$work/package.json"
      jq -e --arg v "$version" '.versions | has($v) and (keys | all(test("^[0-9]+[.][0-9]+[.][0-9]+-")))' "$work/package.json" > /dev/null ||
        fail "Refusing to change latest without a verified prerelease-only version history."
      npm dist-tag rm @kyun.si/codex-polish latest --registry=https://registry.npmjs.org/ ||
        fail "Enable Allow npm dist-tag on this package's GitHub trusted publisher, then retry the tag."
      tag_repaired=true
      expected_latest=''
    elif [[ "$latest" == "$expected_latest" && "$latest" != "$version" ]]; then
      break
    fi
  fi
  if (( SECONDS >= deadline )); then
    fail "Registry verification timed out for $version (beta=$beta, latest=$latest)."
  fi
  if (( attempt == 1 || attempt % 6 == 0 )); then
    echo "Waiting for npm to serve the verified $version archive and its dist-tags."
  fi
  sleep 10
done

if ! "$has_release"; then
  gh release create "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" --verify-tag --prerelease --latest=false --title "Codex Polish $version" --generate-notes
fi
if ! "$has_asset"; then
  gh release upload "$RELEASE_TAG" "$archive" --repo "$GITHUB_REPOSITORY"
fi
inspect_release
"$has_asset" || fail "The verified GitHub release asset is missing."
echo "Verified @kyun.si/codex-polish@$version, npm beta=$expected_beta, and GitHub prerelease $RELEASE_TAG." >> "$GITHUB_STEP_SUMMARY"
