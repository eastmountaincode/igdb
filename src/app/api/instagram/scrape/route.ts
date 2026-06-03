import { NextResponse } from "next/server";
import { backendUrl } from "@/backend-proxy";
import { scrapeInstagramUrl } from "@/instagram-server";

export async function POST(request: Request) {
  try {
    const backend = backendUrl("/api/instagram/scrape");
    if (backend) {
      const body = await request.text();
      const response = await fetch(backend, {
        method: "POST",
        headers: {
          "content-type": request.headers.get("content-type") ?? "application/json"
        },
        body,
        cache: "no-store"
      });

      return new Response(response.body, {
        status: response.status,
        headers: {
          "cache-control": "no-store",
          "content-type": response.headers.get("content-type") ?? "application/json"
        }
      });
    }

    const body = (await request.json()) as { url?: unknown };
    if (typeof body.url !== "string") {
      return NextResponse.json({ error: "Request body must include a URL string." }, { status: 400 });
    }

    return NextResponse.json(await scrapeInstagramUrl(body.url));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 }
    );
  }
}
