import { stageInstagramVideoPart } from "@/lib/instagram-publisher";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_INBOUND_VIDEO_BYTES = 512 * 1024 * 1024;

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const video = form.get("video");
    const audioPayload = form.get("audioPayload");
    const partIndex = Number(form.get("partIndex"));
    const totalParts = Number(form.get("totalParts"));
    if (!(video instanceof File) || video.size <= 0) {
      return Response.json({ error: "The generated video is empty." }, { status: 400 });
    }
    if (video.size > MAX_INBOUND_VIDEO_BYTES) {
      return Response.json({ error: "The generated video is too large for server normalization." }, { status: 413 });
    }
    if (video.type && !video.type.toLowerCase().startsWith("video/mp4")) {
      return Response.json({ error: "The generated upload is not an MP4 video." }, { status: 400 });
    }
    if (audioPayload !== null && (!(audioPayload instanceof File) || audioPayload.size > 80)) {
      return Response.json({ error: "Audio data must be no more than 80 bytes." }, { status: 400 });
    }
    const usableAudioPayload = audioPayload instanceof File && audioPayload.size > 0 ? audioPayload : undefined;
    if (!Number.isInteger(partIndex) || !Number.isInteger(totalParts) || totalParts < 1 || totalParts > 8 || partIndex < 0 || partIndex >= totalParts) {
      return Response.json({ error: "Invalid video part." }, { status: 400 });
    }
    const result = await stageInstagramVideoPart({
      video,
      audioPayload: usableAudioPayload,
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
