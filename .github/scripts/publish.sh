#!/usr/bin/env bash
set -euo pipefail

version=${RELEASE_TAG#v}
filename="kyun.si-codex-polish-$version.tgz"
archive="$RUNNER_TEMP/npm-release/$filename"
registry='https://registry.npmjs.org/@kyun.si%2fcodex-polish'
release="$GITHUB_API_URL/repos/$GITHUB_REPOSITORY/releases/tags/$RELEASE_TAG"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

fail() { echo "$*" >&2; exit 1; }

number='(0|[1-9][0-9]*)'
core="${number}\.${number}\.${number}"
if [[ "$RELEASE_TAG" =~ ^v${core}-beta\.${number}$ ]]; then
  channel=beta
  other=latest
  prerelease=true
  before_pattern="^${core}-beta\.${number}$"
elif [[ "$RELEASE_TAG" =~ ^v${core}$ ]]; then
  channel=latest
  other=beta
  prerelease=false
  # Before the first stable release, npm latest can point to a beta.
  before_pattern="^${core}(-beta\.${number})?$"
else
  fail "Invalid release tag: $RELEASE_TAG"
fi

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
    jq -e --arg tag "$RELEASE_TAG" --argjson pre "$prerelease" '.tag_name == $tag and .prerelease == $pre and .draft == false' "$work/github.json" > /dev/null ||
      fail "Existing GitHub release for $RELEASE_TAG must be published with prerelease=$prerelease."
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
before=$(jq -r --arg tag "$channel" '.[$tag] // empty' "$work/tags.json")
expected_other=$(jq -r --arg tag "$other" '.[$tag] // empty' "$work/tags.json")
integrity_before=$(jq -r '.dist.integrity // empty' "$work/version.json")
expected=$version

if [[ -n "$before" && "$before" != "$version" ]]; then
  [[ "$before" =~ $before_pattern ]] || fail "Unexpected npm $channel tag: $before"
  # sort -V orders numeric components, but a stable core outranks its own betas.
  if [[ "$before" != "$version"-beta.* && $(printf '%s\n%s\n' "$version" "$before" | LC_ALL=C sort -V | tail -n 1) == "$before" ]]; then
    [[ -n "$integrity_before" ]] || fail "Publishing $version would roll back npm $channel from $before."
    expected=$before
  fi
fi

existing=false
if jq -e 'length > 0' "$work/version.json" > /dev/null; then
  existing=true
  jq -e --arg v "$version" '.version == $v and (.dist.integrity | type == "string" and length > 0)' "$work/version.json" > /dev/null ||
    fail "Invalid npm metadata for $version."
  if ! "$has_asset" && [[ "$integrity_before" != "$expected_integrity" ]]; then
    mkdir -p "$work/npm"
    curl -fsS --retry 2 "https://registry.npmjs.org/@kyun.si/codex-polish/-/codex-polish-$version.tgz" -o "$work/npm/$filename"
    use_existing_archive "$work/npm/$filename"
  fi
  [[ "$integrity_before" == "$expected_integrity" ]] || fail "Published version $version has different contents."
else
  npm publish "$archive" --registry=https://registry.npmjs.org/ --tag "$channel" --access public --provenance --ignore-scripts
fi

# npm can return success while a new package is still being processed.
deadline=$((SECONDS + 900))
channel_repaired=false
implicit_latest_removed=false
for ((attempt = 1; ; attempt++)); do
  query="verify=$nonce-after-$attempt"
  fetch_json "$registry/$version?$query" "$work/version.json"
  fetch_json "$tags?$query" "$work/tags.json"
  current=$(jq -r --arg tag "$channel" '.[$tag] // empty' "$work/tags.json")
  other_current=$(jq -r --arg tag "$other" '.[$tag] // empty' "$work/tags.json")
  if [[ $(jq -r '.dist.integrity' "$work/version.json") == "$expected_integrity" ]]; then
    if [[ "$current" == "$expected" && "$other_current" == "$expected_other" ]]; then
      break
    elif "$existing" && ! "$channel_repaired" && [[ "$expected" == "$version" && "$current" == "$before" && "$other_current" == "$expected_other" ]]; then
      # A retry can find the correct immutable version while its channel still lags.
      npm dist-tag add "@kyun.si/codex-polish@$version" "$channel" --registry=https://registry.npmjs.org/ ||
        fail "Enable Allow npm dist-tag on this package's GitHub trusted publisher, then retry the tag."
      channel_repaired=true
    elif [[ "$channel" == beta && -z "$expected_other" && "$current" == "$version" && "$other_current" == "$version" ]] && ! "$implicit_latest_removed"; then
      # npm sometimes assigns latest to the first real version even with --tag beta.
      # Clean up only a newly introduced latest when there are no stable versions.
      fetch_json "$registry?$query" "$work/package.json"
      jq -e --arg v "$version" '.versions | has($v) and (keys | all(test("^[0-9]+[.][0-9]+[.][0-9]+-")))' "$work/package.json" > /dev/null ||
        fail "Refusing to change latest without a verified prerelease-only version history."
      npm dist-tag rm @kyun.si/codex-polish latest --registry=https://registry.npmjs.org/ ||
        fail "Enable Allow npm dist-tag on this package's GitHub trusted publisher, then retry the tag."
      implicit_latest_removed=true
    fi
  fi
  if (( SECONDS >= deadline )); then
    fail "Registry verification timed out for $version ($channel=$current, $other=$other_current)."
  fi
  if (( attempt == 1 || attempt % 6 == 0 )); then
    echo "Waiting for npm to serve the verified $version archive and its dist-tags."
  fi
  sleep 10
done

if ! "$has_release"; then
  if "$prerelease"; then
    flags=(--prerelease --latest=false)
  elif [[ "$expected" == "$version" ]]; then
    flags=(--latest)
  else
    flags=(--latest=false)
  fi
  gh release create "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" --verify-tag "${flags[@]}" --title "Codex Polish $version" --generate-notes
fi
if ! "$has_asset"; then
  gh release upload "$RELEASE_TAG" "$archive" --repo "$GITHUB_REPOSITORY"
fi
inspect_release
"$has_asset" || fail "The verified GitHub release asset is missing."
echo "Verified @kyun.si/codex-polish@$version, npm $channel=$expected, and GitHub release $RELEASE_TAG (prerelease=$prerelease)." >> "$GITHUB_STEP_SUMMARY"
