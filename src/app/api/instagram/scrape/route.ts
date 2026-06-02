import { NextResponse } from "next/server";
import { scrapeInstagramUrl } from "@/instagram-server";

export async function POST(request: Request) {
  try {
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
