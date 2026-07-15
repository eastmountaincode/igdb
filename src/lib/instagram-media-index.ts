import { open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const INDEX_PATH = join(process.cwd(), ".instagram-media-index.json");
const STATUS_PATH = join(process.cwd(), ".instagram-publication-status.json");

export type PublishedMediaRecord = {
  displayCover: boolean;
  createdAt: string;
  requestId?: string;
  permalink?: string;
  parts?: number;
};

type MediaIndex = Record<string, PublishedMediaRecord>;
export type PublicationPartStatus = {
  label: string;
  status: "waiting" | "processing" | "ready" | "failed";
};
type PublicationStatus = Record<string, {
  status: "queued" | "processing" | "failed";
  error?: string;
  parts?: PublicationPartStatus[];
  queuePosition?: number;
  updatedAt: string;
}>;

export async function recordPublicationStatus(
  requestId: string,
  status: "queued" | "processing" | "failed",
  error?: string,
  parts?: PublicationPartStatus[],
  queuePosition?: number
) {
  await withFileLock(`${STATUS_PATH}.lock`, async () => {
    const statuses = await readPublicationStatuses();
    statuses[requestId] = {
      status,
      error,
      parts: parts ?? statuses[requestId]?.parts,
      queuePosition,
      updatedAt: new Date().toISOString()
    };
    await writeJsonAtomic(STATUS_PATH, statuses);
  });
}

export async function findPublicationStatus(requestId: string) {
  return (await readPublicationStatuses())[requestId] ?? null;
}

export async function recordPublishedMedia(
  mediaId: string,
  displayCover: boolean,
  details: { requestId?: string; permalink?: string; parts?: number } = {}
) {
  await withFileLock(`${INDEX_PATH}.lock`, async () => {
    const index = await readIndex();
    index[mediaId] = { displayCover, createdAt: new Date().toISOString(), ...details };
    await writeJsonAtomic(INDEX_PATH, index);
  });
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

async function readPublicationStatuses(): Promise<PublicationStatus> {
  try {
    return JSON.parse(await readFile(STATUS_PATH, "utf8")) as PublicationStatus;
  } catch {
    return {};
  }
}

async function writeJsonAtomic(path: string, value: unknown) {
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(value, null, 2));
  await rename(temporaryPath, path);
}

async function withFileLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      const handle = await open(path, "wx");
      await handle.writeFile(String(process.pid));
      await handle.close();
      try {
        return await operation();
      } finally {
        await rm(path, { force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - (await stat(path)).mtimeMs > 30000) {
          await rm(path, { force: true });
          continue;
        }
      } catch {
        // The lock was released between checks.
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error("Publication record is busy. Please try again.");
}
