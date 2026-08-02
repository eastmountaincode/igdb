import { findPublishedMediaByRequestId } from "@/lib/instagram-media-index";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("id")?.trim() ?? "";
  if (!/^[a-zA-Z0-9-]{16,80}$/.test(id)) {
    return noStoreJson({ error: "Invalid file share link." }, 400);
  }

  const published = await findPublishedMediaByRequestId(id);
  if (!published?.permalink) {
    return noStoreJson({ error: "This file has not finished publishing." }, 404);
  }

  return noStoreJson({ permalink: published.permalink });
}

function noStoreJson(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store, max-age=0" }
  });
}
