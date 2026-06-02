import { isAllowedInstagramMediaUrl } from "@/instagram";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const mediaUrl = requestUrl.searchParams.get("url");

  if (!mediaUrl || !isAllowedInstagramMediaUrl(mediaUrl)) {
    return new Response("Unsupported media URL.", { status: 400 });
  }

  const upstream = await fetch(mediaUrl, {
    headers: {
      accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,video/*,*/*;q=0.8",
      referer: "https://www.instagram.com/",
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36"
    },
    redirect: "follow",
    cache: "no-store"
  });

  if (!upstream.ok || !upstream.body) {
    return new Response(`Media fetch failed with HTTP ${upstream.status}.`, { status: 502 });
  }

  const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
  if (!contentType.startsWith("image/") && !contentType.startsWith("video/")) {
    return new Response("Upstream URL did not return image or video content.", { status: 415 });
  }

  return new Response(upstream.body, {
    headers: {
      "cache-control": "no-store",
      "content-type": contentType
    }
  });
}
