import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const GRAPH_VERSION = "v23.0";
const GRAPH_BASE = `https://graph.instagram.com/${GRAPH_VERSION}`;
const ROOT = join(process.cwd(), "Archive", "normal-shopkeep-instagram");
const POSTS = join(ROOT, "posts");
const MANIFEST = join(ROOT, "manifest.json");
const INDEX = join(process.cwd(), ".instagram-media-index.json");
const CODEC_CAPABILITIES_URL = "https://igdb-instagram-eastmountain.zocomputer.io/api/codec-capabilities";
const token = process.env.INSTAGRAM_ACCESS_TOKEN_NORMAL_SHOPKEEP;

if (!token) throw new Error("INSTAGRAM_ACCESS_TOKEN_NORMAL_SHOPKEEP is not configured");

const decoderCapabilities = await loadDecoderCapabilities();
const decoderRevision = decoderCapabilities.decoderRevision;
const targetMediaId = process.env.ARCHIVE_MEDIA_ID?.trim() ?? "";

await mkdir(POSTS, { recursive: true });
const localIndex = JSON.parse(await readFile(INDEX, "utf8"));
const previous = await readJson(MANIFEST, { posts: {} });
const knownMediaIds = new Set(Object.keys(previous.posts));
const media = await listMedia();
const liveMediaIds = new Set(media.map((item) => item.id));
let downloaded = 0;
let unchanged = 0;
let failed = 0;

for (const item of media) {
  if (targetMediaId && item.id !== targetMediaId) continue;
  const shortcode = new URL(item.permalink).pathname.split("/").filter(Boolean).at(-1);
  const directory = join(POSTS, `${item.timestamp.slice(0, 10)}_${shortcode}`);
  await mkdir(directory, { recursive: true });
  try {
    const existingRecord = previous.posts[item.id] ?? {};
    const recoverySettled = Boolean(
      existingRecord.recoveredFile
      || (existingRecord.decodeError && existingRecord.decodeError.decoderRevision === decoderRevision)
    );
    const detail = await graph(item.id, {
      fields: "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,children{id,media_type,media_url,thumbnail_url}"
    });
    const children = detail.media_type === "CAROUSEL_ALBUM" ? detail.children?.data ?? [] : [detail];
    const hasCover = localIndex[item.id]?.displayCover === true;
    const files = [];
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      const source = child.media_url;
      if (!source) continue;
      const isCover = hasCover && index === 0;
      if (recoverySettled && !isCover) continue;
      const extension = child.media_type === "VIDEO" ? ".mp4" : ".jpg";
      const label = isCover ? "cover" : child.media_type === "VIDEO" ? `data-${String(index - (hasCover ? 0 : -1)).padStart(2, "0")}` : `image-${String(index + 1).padStart(2, "0")}`;
      const path = join(directory, `${label}${extension}`);
      const previousFile = existingRecord.files?.find((file) => file.name === basename(path));
      const result = await download(source, path, Boolean(previousFile && previousFile.mediaId !== child.id));
      result.changed ? downloaded++ : unchanged++;
      files.push({ name: basename(path), mediaId: child.id, mediaType: child.media_type, bytes: result.bytes, sha256: result.sha256 });
    }
    const record = {
      mediaId: item.id,
      permalink: item.permalink,
      timestamp: item.timestamp,
      caption: detail.caption ?? "",
      displayCover: hasCover,
      requestId: localIndex[item.id]?.requestId ?? null,
      files,
      archivedAt: new Date().toISOString(),
      ...(existingRecord.recoveredFile ? { recoveredFile: existingRecord.recoveredFile } : {}),
      ...(existingRecord.decodeError ? { decodeError: existingRecord.decodeError } : {}),
      ...(existingRecord.transientError ? { transientError: existingRecord.transientError } : {})
    };
    await writeJson(join(directory, "post.json"), record);
    previous.posts[item.id] = { directory: directory.slice(ROOT.length + 1), ...record };
    previous.posts[item.id].lastSeenAt = new Date().toISOString();
    delete previous.posts[item.id].removedAt;
  } catch (error) {
    failed++;
    previous.posts[item.id] = {
      ...(previous.posts[item.id] ?? {}),
      mediaId: item.id,
      permalink: item.permalink,
      timestamp: item.timestamp,
      error: error instanceof Error ? error.message : String(error),
      lastAttemptAt: new Date().toISOString()
    };
  }
}

for (const [mediaId, record] of Object.entries(previous.posts)) {
  if (!liveMediaIds.has(mediaId) && !record.removedAt) record.removedAt = new Date().toISOString();
}

previous.account = "normal_shopkeep";
previous.lastRunAt = new Date().toISOString();
previous.currentPostCount = media.length;
previous.summary = {
  downloaded,
  unchanged,
  failed,
  newMediaIds: media.map((item) => item.id).filter((id) => !knownMediaIds.has(id)),
  decoderRevision,
  supportedCodecs: decoderCapabilities.formats.map((format) => format.id)
};
await writeJson(MANIFEST, previous);
console.log(JSON.stringify({ root: ROOT, posts: media.length, downloaded, unchanged, failed }));

async function loadDecoderCapabilities() {
  const response = await fetch(CODEC_CAPABILITIES_URL, { cache: "no-store" });
  if (!response.ok) throw new Error(`Codec capabilities failed (${response.status})`);
  const result = await response.json();
  if (!result.decoderRevision || !Array.isArray(result.formats) || !result.formats.length) {
    throw new Error("Codec capabilities response is invalid");
  }
  return result;
}

async function listMedia() {
  const items = [];
  let next = graphUrl("me/media", { fields: "id,media_type,permalink,timestamp", limit: "100" });
  while (next) {
    const response = await fetch(next);
    if (!response.ok) throw new Error(`Instagram media list failed (${response.status})`);
    const result = await response.json();
    items.push(...(result.data ?? []).filter((item) => item.permalink));
    next = result.paging?.next ?? "";
  }
  return items;
}

async function graph(path, params) {
  const response = await fetch(graphUrl(path, params));
  if (!response.ok) throw new Error(`Instagram media ${path} failed (${response.status}): ${await response.text()}`);
  return response.json();
}

function graphUrl(path, params) {
  const url = new URL(`${GRAPH_BASE}/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set("access_token", token);
  return url.toString();
}

async function download(url, path, force = false) {
  if (!force) {
    try {
      const existing = await stat(path);
      if (existing.size > 0) return { changed: false, bytes: existing.size, sha256: await hashFile(path) };
    } catch {}
  }
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status})`);
  const temporary = `${path}.${process.pid}.tmp`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
  await rename(temporary, path);
  const info = await stat(path);
  return { changed: true, bytes: info.size, sha256: await hashFile(path) };
}

async function hashFile(path) {
  const hash = createHash("sha256");
  await pipeline(Readable.toWeb((await import("node:fs")).createReadStream(path)), new WritableStream({ write(chunk) { hash.update(chunk); } }));
  return hash.digest("hex");
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
}

async function writeJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}
