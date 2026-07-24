#!/usr/bin/env bash
set -euo pipefail

ROOT="/home/workspace/igdb/Archive/normal-shopkeep-instagram"
MANIFEST="$ROOT/manifest.json"
SESSION="igdb-archive-worker"
SITE="https://igdb-instagram-eastmountain.zocomputer.io"
export AGENT_BROWSER_DEFAULT_TIMEOUT=900000

CAPABILITIES_JSON=$(curl -fsS "$SITE/api/codec-capabilities")
DECODER_REVISION=$(jq -er '.decoderRevision' <<<"$CAPABILITIES_JSON")
SUPPORTED_CODECS=$(jq -ec '[.formats[].id]' <<<"$CAPABILITIES_JSON")
TARGET_MEDIA_ID=${ARCHIVE_MEDIA_ID:-}

cleanup() {
  agent-browser --session "$SESSION" close >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

record_error() {
  local media_id="$1"
  local post_json="$2"
  local message="$3"
  local codec_id="$4"
  local at temporary error_field status_label
  if jq -e '.recoveredFile != null' "$post_json" >/dev/null 2>&1; then
    printf 'SKIPPED_STALE_ERROR\t%s\t%s\n' "$media_id" "$message"
    return
  fi
  at=$(date -u +%FT%TZ)
  if grep -Eqi 'network|download|timed out|timeout|could not resolve|No post from|still processing' <<<"$message"; then
    error_field="transientError"
    status_label="RETRY"
  else
    error_field="decodeError"
    status_label="CORRUPT"
  fi
  temporary=$(mktemp)
  jq --arg field "$error_field" --arg message "$message" --arg at "$at" --arg revision "$DECODER_REVISION" --arg codec "$codec_id" --argjson supported "$SUPPORTED_CODECS" \
    '.[$field]={message:$message,attemptedAt:$at,decoderRevision:$revision,detectedCodec:$codec,supportedCodecs:$supported}' "$post_json" >"$temporary" && mv "$temporary" "$post_json"
  temporary=$(mktemp)
  jq --arg id "$media_id" --arg field "$error_field" --arg message "$message" --arg at "$at" --arg revision "$DECODER_REVISION" --arg codec "$codec_id" --argjson supported "$SUPPORTED_CODECS" \
    '.posts[$id][$field]={message:$message,attemptedAt:$at,decoderRevision:$revision,detectedCodec:$codec,supportedCodecs:$supported}' "$MANIFEST" >"$temporary" && mv "$temporary" "$MANIFEST"
  printf '%s\t%s\t%s\n' "$status_label" "$media_id" "$message"
}

jq -r --arg revision "$DECODER_REVISION" --arg target "$TARGET_MEDIA_ID" '.posts | to_entries[] | select(($target == "" or .key == $target) and .value.removedAt == null and .value.recoveredFile == null and (.value.decodeError == null or .value.decodeError.decoderRevision != $revision)) | [.key, .value.permalink, .value.directory] | @tsv' "$MANIFEST" |
while IFS=$'\t' read -r media_id permalink relative_directory; do
  directory="$ROOT/$relative_directory"
  post_json="$directory/post.json"
  encoded_url=$(node -e 'const u=new URL(process.argv[1]); u.searchParams.set("read",process.argv[2]); process.stdout.write(u.href)' "$SITE" "$permalink")
  printf 'START\t%s\t%s\n' "$media_id" "$permalink"
  agent-browser --session "$SESSION" open "$encoded_url" >/dev/null 2>&1 || continue
  agent-browser --session "$SESSION" wait 1000 >/dev/null 2>&1 || true
  agent-browser --session "$SESSION" find role button click --name "read URL" >/dev/null 2>&1 || continue
  body=""
  for _ in $(seq 1 180); do
    body=$(agent-browser --session "$SESSION" get text body 2>/dev/null || true)
    if grep -Eq "SHA-256 OK. Ready to download.|Video decode failed:" <<<"$body"; then
      break
    fi
    sleep 5
  done
  codec_id=$(awk '/^codec$/{getline; value=$0} END{print value}' <<<"$body")
  [ -n "$codec_id" ] && [ "$codec_id" != "—" ] || codec_id="unknown"
  if ! grep -q "SHA-256 OK. Ready to download." <<<"$body"; then
    error=$(awk '/Video decode failed:/{line=$0} END{print line}' <<<"$body")
    [ -n "$error" ] || error="Decode did not produce a SHA-256-verified original."
    record_error "$media_id" "$post_json" "$error" "$codec_id"
    continue
  fi
  file_name=$(awk '/^file$/{getline; value=$0} END{print value}' <<<"$body")
  if [ -z "$file_name" ] || [ "$file_name" = "—" ] || [[ "$file_name" == */* ]]; then
    record_error "$media_id" "$post_json" "Decoder verified the file but returned an unsafe or empty filename." "$codec_id"
    continue
  fi
  target="$directory/$file_name"
  agent-browser --session "$SESSION" eval 'const button=[...document.querySelectorAll("button")].find((element)=>element.textContent?.trim()==="Download Recovered File" && !element.disabled); if(button){button.id="igdb-recovered-download";true}else{false}' >/dev/null 2>&1
  if ! agent-browser --session "$SESSION" download '#igdb-recovered-download' "$target" >/dev/null 2>&1 || [ ! -s "$target" ]; then
    record_error "$media_id" "$post_json" "SHA-256 verification passed, but the recovered browser download failed." "$codec_id"
    continue
  fi
  bytes=$(stat -c %s "$target")
  sha256=$(sha256sum "$target" | cut -d' ' -f1)
  recovered_at=$(date -u +%FT%TZ)
  temporary=$(mktemp)
  jq --arg name "$file_name" --argjson bytes "$bytes" --arg sha256 "$sha256" --arg at "$recovered_at" --arg revision "$DECODER_REVISION" --arg codec "$codec_id" --argjson supported "$SUPPORTED_CODECS" \
    '.recoveredFile={name:$name,bytes:$bytes,sha256:$sha256,recoveredAt:$at,decoderRevision:$revision,codec:$codec,supportedCodecs:$supported} | del(.decodeError,.transientError) | .files=[.files[]? | select((.name | startswith("data-") or endswith("-thumbnail.jpg")) | not)]' "$post_json" >"$temporary" && mv "$temporary" "$post_json"
  temporary=$(mktemp)
  jq --arg id "$media_id" --arg name "$file_name" --argjson bytes "$bytes" --arg sha256 "$sha256" --arg at "$recovered_at" --arg revision "$DECODER_REVISION" --arg codec "$codec_id" --argjson supported "$SUPPORTED_CODECS" \
    '.posts[$id].recoveredFile={name:$name,bytes:$bytes,sha256:$sha256,recoveredAt:$at,decoderRevision:$revision,codec:$codec,supportedCodecs:$supported} | del(.posts[$id].decodeError,.posts[$id].transientError) | .posts[$id].files=[.posts[$id].files[]? | select((.name | startswith("data-") or endswith("-thumbnail.jpg")) | not)]' "$MANIFEST" >"$temporary" && mv "$temporary" "$MANIFEST"
  rm -f "$directory"/data-*.mp4 "$directory"/*-thumbnail.jpg
  printf 'RECOVERED\t%s\t%s\t%s\n' "$media_id" "$sha256" "$file_name"
done
