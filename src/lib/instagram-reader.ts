import { publishedMediaHasCover } from "@/lib/instagram-media-index";

const GRAPH_VERSION = "v23.0";
const GRAPH_BASE_URL = `https://graph.instagram.com/${GRAPH_VERSION}`;
const MAX_MEDIA_PAGES = 10;

type InstagramMedia = {
  id: string;
  media_type: "CAROUSEL_ALBUM" | "IMAGE" | "VIDEO";
  media_url?: string;
  permalink?: string;
  children?: { data?: InstagramMedia[] };
};

export type InstagramReadSource = {
  id: string;
  permalink: string;
  videoUrls: string[];
};

export async function resolveInstagramReadSource(input: string): Promise<InstagramReadSource> {
  const permalink = normalizeInstagramUrl(input);
  const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN_NORMAL_SHOPKEEP;
  if (!accessToken) throw new Error("Instagram is not configured.");

  let nextUrl = graphUrl("me/media", accessToken, {
    fields: "id,media_type,permalink",
    limit: "100"
  });

  for (let page = 0; page < MAX_MEDIA_PAGES && nextUrl; page += 1) {
    const response = await fetch(nextUrl, { cache: "no-store" });
    if (!response.ok) throw new Error("Instagram could not resolve that URL.");
    const result = await response.json() as {
      data?: InstagramMedia[];
      paging?: { next?: string };
    };
    const match = result.data?.find((item) => item.permalink && normalizeInstagramUrl(item.permalink) === permalink);
    if (match) {
      const mediaResponse = await fetch(graphUrl(match.id, accessToken, {
        fields: "id,media_type,media_url,permalink,children{media_type,media_url}"
      }), { cache: "no-store" });
      if (!mediaResponse.ok) throw new Error("Instagram could not load that post.");
      const media = await mediaResponse.json() as InstagramMedia;
      let videoUrls = media.media_type === "CAROUSEL_ALBUM"
        ? (media.children?.data ?? []).filter((item) => item.media_type === "VIDEO" && item.media_url).map((item) => item.media_url as string)
        : media.media_type === "VIDEO" && media.media_url
          ? [media.media_url]
          : [];
      if (await publishedMediaHasCover(media.id)) videoUrls = videoUrls.slice(1);
      if (!videoUrls.length) throw new Error("That Instagram post does not contain a readable video.");
      if (videoUrls.length > 8) throw new Error("That Instagram post contains too many videos.");
      return { id: media.id, permalink, videoUrls };
    }
    nextUrl = result.paging?.next ?? "";
  }

  throw new Error("No post from @normal_shopkeep matches that URL.");
}

export function normalizeInstagramUrl(input: string) {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("Enter a valid Instagram URL.");
  }
  const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  if (url.protocol !== "https:" || hostname !== "instagram.com") throw new Error("Enter an Instagram post or Reel URL.");
  const match = url.pathname.match(/^\/(p|reel)\/([A-Za-z0-9_-]+)\/?$/);
  if (!match) throw new Error("Enter an Instagram post or Reel URL.");
  return `https://www.instagram.com/${match[1]}/${match[2]}/`;
}

function graphUrl(path: string, accessToken: string, params: Record<string, string>) {
  const url = new URL(`${GRAPH_BASE_URL}/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set("access_token", accessToken);
  return url.toString();
}
