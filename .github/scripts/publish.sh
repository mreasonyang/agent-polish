#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/release-tag.sh"
archive="$RUNNER_TEMP/npm-release/$filename"
npm_registry='https://registry.npmjs.org/'
encoded_package=${package/\//%2f}
registry="$npm_registry$encoded_package"
tags="$npm_registry-/package/$encoded_package/dist-tags"
release="$GITHUB_API_URL/repos/$GITHUB_REPOSITORY/releases/tags/$RELEASE_TAG"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

fail() { echo "$*" >&2; exit 1; }

# An annotated tag also has a peeled commit. Lightweight tags point to the commit directly.
verify_tag() {
  local tag_commit
  tag_commit=$(git ls-remote --exit-code origin "refs/tags/$RELEASE_TAG" "refs/tags/$RELEASE_TAG^{}" | tail -n 1 | cut -f1)
  [[ "$tag_commit" == "$SOURCE_SHA" ]] || fail "The tag no longer points to the tested commit."
}

verify_tag
archive_manifest=$(tar -xOzf "$archive" package/package.json)
jq -e --arg pkg "$package" --arg v "$version" --arg channel "$channel" --arg registry "$npm_registry" '
  .name == $pkg and .version == $v and .private != true and
  .publishConfig.tag == $channel and .publishConfig.access == "public" and .publishConfig.registry == $registry
' <<< "$archive_manifest" > /dev/null || fail "The verified archive has unexpected package metadata."

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

fetch_history() {
  fetch_json "$registry?$1" "$work/package.json"
  jq -e --arg pkg "$package" 'length == 0 or (.name == $pkg and (.versions | type == "object"))' "$work/package.json" > /dev/null ||
    fail "Invalid npm version history for $package."
}

agy_prerelease_tag() {
  [[ "$host" == agy && ( "$1" == 0.0.0-stage || "$1" =~ ^${core}-beta\.${number}$ ) ]]
}

verify_prerelease_latest() {
  local latest=$1 stable=${2:-}
  jq -e --arg latest "$latest" --arg stable "$stable" '
    .["dist-tags"].latest == $latest and
    (.versions | has($latest) and (keys | all(. == $stable or test("^[0-9]+[.][0-9]+[.][0-9]+-"))))
  ' "$work/package.json" > /dev/null ||
    fail "Refusing to change or accept npm latest without a verified prerelease-only version history."
}

newest_in_channel_history() {
  jq -r --arg re "$history_pattern" '.versions | keys[] | select(test($re))' "$work/package.json" | LC_ALL=C sort -V | tail -n 1
}

is_newer_than_target() {
  [[ -n "$1" && "$1" != "$version" && $(printf '%s\n%s\n' "$version" "$1" | LC_ALL=C sort -V | tail -n 1) == "$1" ]]
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
      local digest download
      digest=$(jq -er --arg name "$filename" '.assets[] | select(.name == $name and .state == "uploaded") | .digest // ""' "$work/github.json")
      if [[ -z "$digest" || ( "$digest" != "$expected_digest" && ${1:-} == reuse ) ]]; then
        download=$(mktemp -d "$work/github.XXXXXX")
        gh release download "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" --pattern "$filename" --dir "$download"
        if [[ ${1:-} == reuse ]]; then
          use_existing_archive "$download/$filename"
        fi
        if [[ -z "$digest" ]]; then
          digest="sha256:$(sha256sum "$download/$filename" | cut -d' ' -f1)"
        fi
      fi
      [[ "$expected_digest" == "$digest" ]] || fail "The existing GitHub release asset checksum differs."
    fi
  fi
}

inspect_release reuse
nonce="$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
fetch_json "$tags?verify=$nonce-before" "$work/tags.json"
fetch_json "$registry/$version?verify=$nonce-before" "$work/version.json"
before=$(jq -r --arg tag "$channel" '.[$tag] // empty' "$work/tags.json")
expected_other=$(jq -r --arg tag "$other" '.[$tag] // empty' "$work/tags.json")
integrity_before=$(jq -r '.dist.integrity // empty' "$work/version.json")
expected=$version

# A missing dist-tag can also mean it was deleted after a newer version shipped.
# AgY stable releases also check for a newer stable behind the current latest.
if [[ -z "$before" || ( "$host" == agy && "$channel" == latest ) ]] || agy_prerelease_tag "$expected_other"; then
  fetch_history "verify=$nonce-history"
  if jq -e 'length > 0' "$work/package.json" > /dev/null; then
    if [[ -z "$before" ]]; then
      before=$(jq -r --arg tag "$channel" '.["dist-tags"][$tag] // empty' "$work/package.json")
    fi
    if [[ -z "$before" || ( "$host" == agy && "$channel" == latest ) ]]; then
      newest=$(newest_in_channel_history)
      if is_newer_than_target "$newest"; then
        [[ -n "$integrity_before" ]] || fail "Publishing $version would roll back npm $channel from $newest."
        expected=$before
      fi
    fi
  elif [[ -n "$integrity_before" ]]; then
    fail "Missing npm version history for $package."
  fi
fi

# AgY has no stable latest to roll back when latest still points to a prerelease.
# Recovery may find that the requested stable version is already published.
first_agy_stable=false
if [[ "$channel" == latest ]] && agy_prerelease_tag "$before"; then
  already_published_stable=''
  [[ -z "$integrity_before" ]] || already_published_stable=$version
  verify_prerelease_latest "$before" "$already_published_stable"
  first_agy_stable=true
elif [[ "$channel" == beta ]] && agy_prerelease_tag "$expected_other"; then
  verify_prerelease_latest "$expected_other"
fi

if [[ -n "$before" && "$before" != "$version" ]] && ! "$first_agy_stable"; then
  [[ "$before" =~ $before_pattern ]] || fail "Unexpected npm $channel tag: $before"
  # sort -V orders numeric components, but a stable core outranks its own betas.
  if [[ "$before" != "$version"-beta.* ]] && is_newer_than_target "$before"; then
    [[ -n "$integrity_before" ]] || fail "Publishing $version would roll back npm $channel from $before."
    expected=$before
  fi
fi

existing=false
if jq -e 'length > 0' "$work/version.json" > /dev/null; then
  existing=true
  jq -e --arg pkg "$package" --arg v "$version" '.name == $pkg and .version == $v and (.dist.integrity | type == "string" and length > 0)' "$work/version.json" > /dev/null ||
    fail "Invalid npm metadata for $version."
  if ! "$has_asset" && [[ "$integrity_before" != "$expected_integrity" ]]; then
    mkdir -p "$work/npm"
    curl -fsS --retry 2 --connect-timeout 10 --max-time 30 "$npm_registry$package/-/$product-$version.tgz" -o "$work/npm/$filename"
    use_existing_archive "$work/npm/$filename"
  fi
  [[ "$integrity_before" == "$expected_integrity" ]] || fail "Published version $version has different contents."
else
  "$legacy" && fail "Legacy tags can recover published Codex versions. Publish new versions with a host tag."
  [[ "$GITHUB_REF" == "refs/tags/$RELEASE_TAG" ]] || fail "Dispatch from the release tag to attest the tagged commit."
  jq -e --arg url "git+https://github.com/$GITHUB_REPOSITORY.git" '.repository.url == $url' <<< "$archive_manifest" > /dev/null ||
    fail "The archive repository must match the GitHub repository for provenance."
  if [[ "$host" == agy ]]; then
    fetch_history "verify=$nonce-bootstrap"
    jq -e --arg pkg "$package" '.name == $pkg' "$work/package.json" > /dev/null ||
      fail "Create $package on npm and configure its trusted publisher before releasing. See CONTRIBUTING.md."
    if "$first_agy_stable"; then
      verify_prerelease_latest "$before"
    elif [[ "$channel" == latest ]]; then
      newest=$(newest_in_channel_history)
      if is_newer_than_target "$newest"; then
        fail "Publishing $version would roll back npm latest from $newest."
      fi
    elif agy_prerelease_tag "$expected_other"; then
      verify_prerelease_latest "$expected_other"
    fi
  fi
  npm publish "$archive" --registry="$npm_registry" --tag "$channel" --access public --provenance --ignore-scripts
fi

# npm can return success while a new package is still being processed.
deadline=$((SECONDS + 900))
channel_repaired=false
for ((attempt = 1; ; attempt++)); do
  query="verify=$nonce-after-$attempt"
  fetch_json "$registry/$version?$query" "$work/version.json"
  fetch_json "$tags?$query" "$work/tags.json"
  current=$(jq -r --arg tag "$channel" '.[$tag] // empty' "$work/tags.json")
  other_current=$(jq -r --arg tag "$other" '.[$tag] // empty' "$work/tags.json")
  seen_integrity=$(jq -r '.dist.integrity // empty' "$work/version.json")
  if [[ -n "$seen_integrity" ]]; then
    [[ "$seen_integrity" == "$expected_integrity" ]] || fail "Published version $version has different contents."
    other_verified=false
    if [[ "$other_current" == "$expected_other" ]]; then
      if [[ "$channel" == beta ]] && agy_prerelease_tag "$other_current"; then
        fetch_history "$query-history"
        verify_prerelease_latest "$other_current"
      fi
      other_verified=true
    elif [[ "$host" == agy && "$channel" == beta && "$expected" == "$version" &&
            ( -z "$expected_other" || "$expected_other" == 0.0.0-stage ) &&
            ( -z "$other_current" || "$other_current" == 0.0.0-stage || "$other_current" == "$version" ) ]]; then
      # npm can assign latest to the first public beta or retire the staging placeholder.
      fetch_history "$query-history"
      if jq -e --arg v "$version" --arg latest "$other_current" '
        (.["dist-tags"].latest // "") == $latest and
        (.versions | has($v) and (keys | all(. == $v or . == "0.0.0-stage")))
      ' "$work/package.json" > /dev/null; then
        other_verified=true
      fi
    fi
    if [[ "$current" == "$expected" ]] && "$other_verified"; then
      break
    fi
    if "$existing" && ! "$channel_repaired" && "$other_verified" &&
       [[ "$expected" == "$version" && "$current" != "$version" && "$current" == "$before" ]]; then
      # A retry can find the correct immutable version while its channel still lags.
      if [[ "$host" == agy ]]; then
        fetch_history "$query-repair"
        jq -e --arg channel "$channel" --arg v "$current" --arg other "$other" --arg ov "$other_current" '
          (.["dist-tags"][$channel] // "") == $v and (.["dist-tags"][$other] // "") == $ov
        ' "$work/package.json" > /dev/null || fail "npm $channel or $other changed while verifying $version."
        newest=$(newest_in_channel_history)
        if is_newer_than_target "$newest"; then
          fail "Restoring $version would roll back npm $channel from $newest."
        fi
        if "$first_agy_stable"; then
          verify_prerelease_latest "$current" "$version"
        elif [[ "$channel" == beta ]] && agy_prerelease_tag "$other_current"; then
          verify_prerelease_latest "$other_current"
        fi
      fi
      npm dist-tag add "$package@$version" "$channel" --registry="$npm_registry" ||
        fail "Enable Allow npm dist-tag on this package's GitHub trusted publisher, then retry the tag."
      channel_repaired=true
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

verify_tag
if ! "$has_release"; then
  if "$prerelease"; then
    flags=(--prerelease --latest=false)
  elif [[ "$host" == codex && "$expected" == "$version" ]] && ! "$legacy"; then
    flags=(--latest)
  else
    flags=(--latest=false)
  fi
  title='Codex Polish'
  [[ "$host" != agy ]] || title='Antigravity Polish'
  gh release create "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" --verify-tag "${flags[@]}" --title "$title $version" --generate-notes
fi
if ! "$has_asset"; then
  gh release upload "$RELEASE_TAG" "$archive" --repo "$GITHUB_REPOSITORY"
fi
inspect_release
"$has_asset" || fail "The verified GitHub release asset is missing."
echo "Verified $package@$version, npm $channel=${expected:-unset}, and GitHub release $RELEASE_TAG (prerelease=$prerelease)." >> "$GITHUB_STEP_SUMMARY"
