export const DEFAULT_INSTAGRAM_TEST_URL = "";

export type InstagramMediaReference = {
  url: string;
  kind: "image" | "video";
  contentType?: string;
  width?: number;
  height?: number;
  source?: string;
};

export type InstagramScrapeResult = {
  sourceUrl: string;
  captionText?: string;
  images: InstagramMediaReference[];
  videos: InstagramMediaReference[];
  warnings: string[];
};

const INSTAGRAM_ALLOWED_HOSTS = [
  "instagram.com",
  "cdninstagram.com",
  "fbcdn.net",
  "fbsbx.com"
];

export function normalizeInstagramUrl(rawUrl: string) {
  const url = new URL(rawUrl.trim());
  if (!isInstagramHost(url.hostname)) {
    throw new Error("Only Instagram URLs are supported.");
  }
  url.hash = "";
  return url.toString();
}

export function isAllowedInstagramMediaUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    return INSTAGRAM_ALLOWED_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

export function isInstagramHost(hostname: string) {
  return hostname === "instagram.com" || hostname.endsWith(".instagram.com");
}
