import { stageInstagramVideoPart } from "@/lib/instagram-publisher";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const video = form.get("video");
    const audioPayload = form.get("audioPayload");
    const partIndex = Number(form.get("partIndex"));
    const totalParts = Number(form.get("totalParts"));
    if (!(video instanceof File) || video.size <= 0 || video.size > MAX_VIDEO_BYTES || (video.type && video.type !== "video/mp4")) {
      return Response.json({ error: "Upload must be an MP4 smaller than 100 MB." }, { status: 400 });
    }
    if (audioPayload !== null && (!(audioPayload instanceof File) || audioPayload.size <= 0 || audioPayload.size > 80)) {
      return Response.json({ error: "Invalid audio payload." }, { status: 400 });
    }
    if (!Number.isInteger(partIndex) || !Number.isInteger(totalParts) || totalParts < 1 || totalParts > 8 || partIndex < 0 || partIndex >= totalParts) {
      return Response.json({ error: "Invalid video part." }, { status: 400 });
    }
    const result = await stageInstagramVideoPart({
      video,
      audioPayload: audioPayload instanceof File ? audioPayload : undefined,
      partIndex,
      totalParts,
      uploadId: String(form.get("uploadId") ?? "") || undefined,
      uploadToken: String(form.get("uploadToken") ?? "") || undefined,
      displayCover: form.get("displayCover") === "true"
    });
    return Response.json(result);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Video upload failed." }, { status: 500 });
  }
}
