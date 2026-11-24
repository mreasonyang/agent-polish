#!/usr/bin/env bash
# Source this file to derive the single npm target from RELEASE_TAG.

number='(0|[1-9][0-9]*)'
core="${number}\.${number}\.${number}"
if ! [[ "$RELEASE_TAG" =~ ^((codex|agy)-)?v(${core}(-beta\.${number})?)$ ]]; then
  echo "Invalid release tag: $RELEASE_TAG" >&2
  exit 1
fi

host=${BASH_REMATCH[2]:-codex}
version=${BASH_REMATCH[3]}
legacy=false
[[ "$RELEASE_TAG" != v* ]] || legacy=true
product="$host-polish"
package="@kyun.si/$product"
filename="kyun.si-$product-$version.tgz"

if [[ "$version" == *-beta.* ]]; then
  channel=beta
  other=latest
  prerelease=true
  before_pattern="^${core}-beta\.${number}$"
  history_pattern=$before_pattern
else
  channel=latest
  other=beta
  prerelease=false
  before_pattern="^${core}(-beta\.${number})?$"
  history_pattern="^${core}$"
fi
