import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const INDEX_PATH = join(process.cwd(), ".instagram-media-index.json");

export type PublishedMediaRecord = {
  displayCover: boolean;
  createdAt: string;
  requestId?: string;
  permalink?: string;
  parts?: number;
};

type MediaIndex = Record<string, PublishedMediaRecord>;

export async function recordPublishedMedia(
  mediaId: string,
  displayCover: boolean,
  details: { requestId?: string; permalink?: string; parts?: number } = {}
) {
  const index = await readIndex();
  index[mediaId] = { displayCover, createdAt: new Date().toISOString(), ...details };
  await writeFile(INDEX_PATH, JSON.stringify(index, null, 2));
}

export async function findPublishedMediaByRequestId(requestId: string) {
  const index = await readIndex();
  const match = Object.entries(index).find(([, record]) => record.requestId === requestId);
  return match ? { mediaId: match[0], ...match[1] } : null;
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
