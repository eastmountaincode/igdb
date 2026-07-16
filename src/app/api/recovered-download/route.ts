import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DOWNLOAD_DIR = join(process.cwd(), ".recovered-downloads");
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_AGE_MS = 15 * 60 * 1000;

async function removeExpiredDownloads() {
  await mkdir(DOWNLOAD_DIR, { recursive: true });
  const now = Date.now();
  for (const entry of await readdir(DOWNLOAD_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const createdAt = Number(entry.name.split("-")[0]);
    if (!Number.isFinite(createdAt) || now - createdAt > MAX_AGE_MS) {
      await rm(join(DOWNLOAD_DIR, entry.name), { recursive: true, force: true });
    }
  }
}

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File) || file.size <= 0 || file.size > MAX_FILE_BYTES) {
      return Response.json({ error: "Recovered file must be no more than 25 MB." }, { status: 400 });
    }

    await removeExpiredDownloads();
    const token = `${Date.now()}-${randomUUID()}`;
    const directory = join(DOWNLOAD_DIR, token);
    await mkdir(directory, { recursive: false });
    await Promise.all([
      writeFile(join(directory, "file"), Buffer.from(await file.arrayBuffer())),
      writeFile(join(directory, "name"), file.name || "recovered-file")
    ]);

    return Response.json(
      { downloadUrl: `/api/recovered-download/${encodeURIComponent(token)}` },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Download could not be prepared." },
      { status: 500 }
    );
  }
}
