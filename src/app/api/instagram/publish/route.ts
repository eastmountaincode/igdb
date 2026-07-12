import { publishInstagramVideos } from "@/lib/instagram-publisher";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const MAX_NOTE_LENGTH = 1000;
const attemptsByAddress = new Map<string, number[]>();

export async function POST(request: Request) {
  try {
    enforceRateLimit(request);
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.includes("multipart/form-data")) {
      return Response.json({ error: "Expected a multipart upload." }, { status: 415 });
    }
    const form = await request.formData();
    if (form.get("confirmation") !== "publish-to-normal-shopkeep") {
      return Response.json({ error: "Publishing confirmation is required." }, { status: 400 });
    }

    const videos = form.getAll("videos").filter((value): value is File => value instanceof File);
    if (!videos.length || videos.length > 8) {
      return Response.json({ error: "Upload between 1 and 8 MP4 videos." }, { status: 400 });
    }
    for (const video of videos) {
      if (video.size <= 0 || video.size > MAX_VIDEO_BYTES || (video.type && video.type !== "video/mp4")) {
        return Response.json({ error: "Every upload must be an MP4 smaller than 100 MB." }, { status: 400 });
      }
    }

    const originalName = requiredText(form, "originalName", 255);
    const originalType = requiredText(form, "originalType", 255);
    const originalSize = Number(form.get("originalSize"));
    const note = String(form.get("note") ?? "").trim();
    if (!Number.isSafeInteger(originalSize) || originalSize < 0) {
      return Response.json({ error: "Invalid original file size." }, { status: 400 });
    }
    if (note.length > MAX_NOTE_LENGTH) {
      return Response.json({ error: `Note must be ${MAX_NOTE_LENGTH} characters or fewer.` }, { status: 400 });
    }

    const configuredBaseUrl = process.env.INSTAGRAM_MEDIA_BASE_URL?.replace(/\/$/, "");
    const forwardedHost = request.headers.get("x-forwarded-host") || request.headers.get("host");
    const forwardedProto = request.headers.get("x-forwarded-proto");
    const forwardedOrigin = forwardedHost && forwardedProto ? `${forwardedProto}://${forwardedHost}` : "";
    const mediaBaseUrl = configuredBaseUrl || forwardedOrigin || new URL(request.url).origin;
    if (!mediaBaseUrl.startsWith("https://")) {
      return Response.json({ error: "Instagram publishing requires a public HTTPS site URL." }, { status: 503 });
    }

    const result = await publishInstagramVideos({
      videos,
      metadata: { name: originalName, type: originalType, size: originalSize, note },
      mediaBaseUrl
    });
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Instagram publishing failed.";
    return Response.json({ error: message }, { status: 500 });
  }
}

function requiredText(form: FormData, field: string, maxLength: number) {
  const value = String(form.get(field) ?? "").trim();
  if (!value || value.length > maxLength) throw new Error(`Invalid ${field}.`);
  return value;
}

function enforceRateLimit(request: Request) {
  const address = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const now = Date.now();
  const recent = (attemptsByAddress.get(address) ?? []).filter((time) => now - time < 60 * 60 * 1000);
  if (recent.length >= 3) throw new Error("Publishing limit reached. Try again later.");
  recent.push(now);
  attemptsByAddress.set(address, recent);
}
