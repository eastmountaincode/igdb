import { publishInstagramVideos, publishStagedInstagramVideos } from "@/lib/instagram-publisher";
import { MAX_SOURCE_FILE_BYTES, MAX_SOURCE_FILE_LABEL } from "@/upload-limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const MAX_ADDED_BY_LENGTH = 100;
const MAX_NOTE_LENGTH = 1000;
const attemptsByAddress = new Map<string, Array<{ time: number; key: string }>>();

export async function POST(request: Request) {
  try {
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const body = await request.json() as Record<string, unknown>;
      if (body.confirmation !== "publish-to-normal-shopkeep") {
        return Response.json({ error: "Publishing confirmation is required." }, { status: 400 });
      }
      const originalName = requiredValue(body.originalName, "originalName", 1024);
      const originalType = requiredValue(body.originalType, "originalType", 255);
      const originalSize = Number(body.originalSize);
      const addedBy = String(body.addedBy ?? "").trim();
      const note = String(body.note ?? "").trim();
      const uploadId = requiredValue(body.uploadId, "uploadId", 255);
      const publishRequestId = optionalRequestId(body.publishRequestId);
      enforceRateLimit(request, publishRequestId ?? uploadId);
      if (!Number.isSafeInteger(originalSize) || originalSize < 0 || originalSize > MAX_SOURCE_FILE_BYTES) {
        return Response.json({ error: `Files must be ${MAX_SOURCE_FILE_LABEL} or smaller.` }, { status: 413 });
      }
      if (note.length > MAX_NOTE_LENGTH) {
        return Response.json({ error: `Note must be ${MAX_NOTE_LENGTH} characters or fewer.` }, { status: 400 });
      }
      if (addedBy.length > MAX_ADDED_BY_LENGTH) {
        return Response.json({ error: `Added by must be ${MAX_ADDED_BY_LENGTH} characters or fewer.` }, { status: 400 });
      }
      const result = await publishStagedInstagramVideos({
        uploadId,
        uploadToken: requiredValue(body.uploadToken, "uploadToken", 255),
        metadata: { name: originalName, type: originalType, size: originalSize, addedBy, note },
        mediaBaseUrl: getMediaBaseUrl(request),
        publishRequestId
      });
      console.log("[api/instagram/publish] accepted", { requestId: result.requestId, parts: result.parts });
      return noStoreJson(result, 202);
    }
    if (!contentType.includes("multipart/form-data")) {
      return Response.json({ error: "Expected a multipart upload." }, { status: 415 });
    }
    const form = await request.formData();
    if (form.get("confirmation") !== "publish-to-normal-shopkeep") {
      return Response.json({ error: "Publishing confirmation is required." }, { status: 400 });
    }

    const videos = form.getAll("videos").filter((value): value is File => value instanceof File);
    const audioPayloads = form.getAll("audioPayloads").filter((value): value is File => value instanceof File);
    if (!videos.length || videos.length > 8) {
      return Response.json({ error: "Upload between 1 and 8 MP4 videos." }, { status: 400 });
    }
    for (const video of videos) {
      if (video.size <= 0 || video.size > MAX_VIDEO_BYTES || (video.type && video.type !== "video/mp4")) {
        return Response.json({ error: "Every upload must be an MP4 smaller than 100 MB." }, { status: 400 });
      }
    }
    if (audioPayloads.length && audioPayloads.length !== videos.length) {
      return Response.json({ error: "Every video must include one audio payload." }, { status: 400 });
    }
    for (const audioPayload of audioPayloads) {
      if (audioPayload.size <= 0 || audioPayload.size > 80) {
        return Response.json({ error: "Invalid audio payload." }, { status: 400 });
      }
    }

    const originalName = requiredText(form, "originalName", 1024);
    const originalType = requiredText(form, "originalType", 255);
    const originalSize = Number(form.get("originalSize"));
    enforceRateLimit(request, `${originalName}:${originalSize}`);
    const addedBy = String(form.get("addedBy") ?? "").trim();
    const note = String(form.get("note") ?? "").trim();
    if (!Number.isSafeInteger(originalSize) || originalSize < 0) {
      return Response.json({ error: "Invalid original file size." }, { status: 400 });
    }
    if (originalSize > MAX_SOURCE_FILE_BYTES) {
      return Response.json({ error: `Files must be ${MAX_SOURCE_FILE_LABEL} or smaller.` }, { status: 413 });
    }
    if (note.length > MAX_NOTE_LENGTH) {
      return Response.json({ error: `Note must be ${MAX_NOTE_LENGTH} characters or fewer.` }, { status: 400 });
    }
    if (addedBy.length > MAX_ADDED_BY_LENGTH) {
      return Response.json({ error: `Added by must be ${MAX_ADDED_BY_LENGTH} characters or fewer.` }, { status: 400 });
    }

    const result = await publishInstagramVideos({
      videos,
      audioPayloads,
      metadata: { name: originalName, type: originalType, size: originalSize, addedBy, note },
      mediaBaseUrl: getMediaBaseUrl(request)
    });
    return noStoreJson(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Instagram publishing failed.";
    console.error("[api/instagram/publish] failed", { message });
    return noStoreJson({ error: message }, 500);
  }
}

function noStoreJson(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store, max-age=0" }
  });
}

function optionalRequestId(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  if (!/^[a-zA-Z0-9-]{16,80}$/.test(text)) throw new Error("Invalid publication request ID.");
  return text;
}

function requiredValue(value: unknown, field: string, maxLength: number) {
  const text = String(value ?? "").trim();
  if (!text || text.length > maxLength) throw new Error(`Invalid ${field}.`);
  return text;
}

function getMediaBaseUrl(request: Request) {
  const configuredBaseUrl = process.env.INSTAGRAM_MEDIA_BASE_URL?.replace(/\/$/, "");
  const forwardedHost = request.headers.get("x-forwarded-host") || request.headers.get("host");
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const forwardedOrigin = forwardedHost && forwardedProto ? `${forwardedProto}://${forwardedHost}` : "";
  const mediaBaseUrl = configuredBaseUrl || forwardedOrigin || new URL(request.url).origin;
  if (!mediaBaseUrl.startsWith("https://")) throw new Error("Instagram publishing requires a public HTTPS site URL.");
  return mediaBaseUrl;
}

function requiredText(form: FormData, field: string, maxLength: number) {
  const value = String(form.get(field) ?? "").trim();
  if (!value || value.length > maxLength) throw new Error(`Invalid ${field}.`);
  return value;
}

function enforceRateLimit(request: Request, key: string) {
  const address = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const now = Date.now();
  const recent = (attemptsByAddress.get(address) ?? []).filter((attempt) => now - attempt.time < 60 * 60 * 1000);
  if (!recent.some((attempt) => attempt.key === key)) {
    if (recent.length >= 3) throw new Error("Publishing limit reached. Try again later.");
    recent.push({ time: now, key });
  }
  attemptsByAddress.set(address, recent);
}
