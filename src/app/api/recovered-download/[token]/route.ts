import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DOWNLOAD_DIR = join(process.cwd(), ".recovered-downloads");
const TOKEN_PATTERN = /^\d{13}-[0-9a-f-]{36}$/i;

function contentDisposition(fileName: string) {
  const cleanName = fileName.replace(/[\r\n]/g, " ").trim() || "recovered-file";
  const asciiName = cleanName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encodedName = encodeURIComponent(cleanName).replace(/['()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`;
}

export async function GET(_request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  if (!TOKEN_PATTERN.test(token)) return new Response("Not found", { status: 404 });

  try {
    const [bytes, rawName] = await Promise.all([
      readFile(join(DOWNLOAD_DIR, token, "file")),
      readFile(join(DOWNLOAD_DIR, token, "name"), "utf8")
    ]);
    return new Response(bytes, {
      headers: {
        "Cache-Control": "private, no-store, max-age=0",
        "Content-Disposition": contentDisposition(rawName),
        "Content-Length": String(bytes.byteLength),
        "Content-Type": "application/octet-stream",
        "X-Content-Type-Options": "nosniff"
      }
    });
  } catch {
    return new Response("Download expired or was not found.", { status: 404 });
  }
}
