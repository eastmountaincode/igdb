import { readStagedMedia } from "@/lib/instagram-publisher";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ jobId: string; fileName: string }> }) {
  try {
    const { jobId, fileName } = await context.params;
    const token = new URL(request.url).searchParams.get("token") ?? "";
    const media = await readStagedMedia(jobId, fileName, token);
    return new Response(media, {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(media.byteLength),
        "Cache-Control": "private, no-store"
      }
    });
  } catch {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
}
