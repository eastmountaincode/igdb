import { findPublicationStatus, findPublishedMediaByRequestId } from "@/lib/instagram-media-index";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await request.json() as Record<string, unknown>;
  const requestId = String(body.publishRequestId ?? "").trim();
  if (!/^[a-zA-Z0-9-]{16,80}$/.test(requestId)) {
    return Response.json({ error: "Invalid publication request ID." }, { status: 400 });
  }
  const published = await findPublishedMediaByRequestId(requestId);
  const publication = published ? null : await findPublicationStatus(requestId);
  return Response.json(
    published
      ? { status: "published", mediaId: published.mediaId, permalink: published.permalink, parts: published.parts }
      : publication?.status === "failed"
        ? { status: "failed", error: publication.error || "Instagram publishing failed.", videos: publication.parts }
        : { status: "processing", videos: publication?.parts },
    { headers: { "Cache-Control": "private, no-store, max-age=0" } }
  );
}
