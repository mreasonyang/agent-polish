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

expected_integrity="sha512-$(openssl dgst -sha512 -binary "$archive" | openssl base64 -A)"
expected_digest="sha256:$(sha256sum "$archive" | cut -d' ' -f1)"

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
      jq -e --arg name "$filename" --arg digest "$expected_digest" '.assets | any(.name == $name and .state == "uploaded" and .digest == $digest)' "$work/github.json" > /dev/null ||
        fail "The existing GitHub release asset differs from the tested archive."
    fi
  fi
}

inspect_release
nonce="$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
fetch_json "$registry/latest?verify=$nonce-before" "$work/latest.json"
fetch_json "$registry/beta?verify=$nonce-before" "$work/beta.json"
fetch_json "$registry/$version?verify=$nonce-before" "$work/version.json"
latest_before=$(jq -c '.version' "$work/latest.json")
beta_before=$(jq -r '.version // empty' "$work/beta.json")
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
  [[ "$integrity_before" == "$expected_integrity" ]] || fail "Published version $version has different contents."
else
  npm publish "$archive" --registry=https://registry.npmjs.org/ --tag beta --access public --provenance --ignore-scripts
fi

for attempt in {1..12}; do
  query="verify=$nonce-after-$attempt"
  fetch_json "$registry/$version?$query" "$work/version.json"
  fetch_json "$registry/beta?$query" "$work/beta.json"
  fetch_json "$registry/latest?$query" "$work/latest.json"
  if [[ $(jq -r '.dist.integrity' "$work/version.json") == "$expected_integrity" &&
        $(jq -r '.version' "$work/beta.json") == "$expected_beta" &&
        $(jq -c '.version' "$work/latest.json") == "$latest_before" ]]; then
    break
  fi
  [[ "$attempt" != 12 ]] || fail "npm integrity, beta or latest verification failed for $version."
  sleep 5
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
