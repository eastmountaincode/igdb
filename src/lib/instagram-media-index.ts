import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const INDEX_PATH = join(process.cwd(), ".instagram-media-index.json");

type MediaIndex = Record<string, { displayCover: boolean; createdAt: string }>;

export async function recordPublishedMedia(mediaId: string, displayCover: boolean) {
  const index = await readIndex();
  index[mediaId] = { displayCover, createdAt: new Date().toISOString() };
  await writeFile(INDEX_PATH, JSON.stringify(index, null, 2));
}

export async function publishedMediaHasCover(mediaId: string) {
  const index = await readIndex();
  return index[mediaId]?.displayCover === true;
}

async function readIndex(): Promise<MediaIndex> {
  try {
    return JSON.parse(await readFile(INDEX_PATH, "utf8")) as MediaIndex;
  } catch {
    return {};
  }
}
