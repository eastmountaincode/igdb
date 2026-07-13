import { resolveInstagramReadSource } from "@/lib/instagram-reader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { url?: unknown };
    const source = await resolveInstagramReadSource(String(body.url ?? ""));
    return Response.json({ permalink: source.permalink, parts: source.videoUrls.length });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Instagram URL could not be read." }, { status: 400 });
  }
}

export async function GET(request: Request) {
  try {
    const requestUrl = new URL(request.url);
    const source = await resolveInstagramReadSource(requestUrl.searchParams.get("url") ?? "");
    const part = Number(requestUrl.searchParams.get("part"));
    if (!Number.isInteger(part) || part < 0 || part >= source.videoUrls.length) {
      return Response.json({ error: "Invalid video part." }, { status: 400 });
    }
    const upstream = await fetch(source.videoUrls[part], { cache: "no-store", redirect: "follow" });
    if (!upstream.ok || !upstream.body) throw new Error("Instagram video download failed.");
    const contentLength = upstream.headers.get("content-length");
    return new Response(upstream.body, {
      headers: {
        "Content-Type": "video/mp4",
        ...(contentLength ? { "Content-Length": contentLength } : {}),
        "Cache-Control": "private, no-store"
      }
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Instagram video download failed." }, { status: 400 });
  }
}
