import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  isAllowedInstagramMediaUrl,
  normalizeInstagramUrl,
  type InstagramMediaReference,
  type InstagramScrapeResult
} from "@/instagram";

const INSTAGRAM_HEADERS = {
  accept: "text/html,application/xhtml+xml",
  "accept-language": "en-US,en;q=0.9",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36"
};

type YtDlpFormat = {
  url?: unknown;
  ext?: unknown;
  width?: unknown;
  height?: unknown;
  format_id?: unknown;
  vcodec?: unknown;
  acodec?: unknown;
  tbr?: unknown;
};

type YtDlpInfo = {
  url?: unknown;
  webpage_url?: unknown;
  title?: unknown;
  description?: unknown;
  width?: unknown;
  height?: unknown;
  ext?: unknown;
  formats?: unknown;
  thumbnails?: unknown;
  entries?: unknown;
};

export async function scrapeInstagramUrl(rawUrl: string): Promise<InstagramScrapeResult> {
  const sourceUrl = normalizeInstagramUrl(rawUrl);
  const warnings: string[] = [];

  try {
    const ytDlpResult = await scrapeInstagramWithYtDlp(sourceUrl);
    return {
      sourceUrl,
      captionText: ytDlpResult.captionText,
      images: uniqueMedia(ytDlpResult.images ?? []),
      videos: uniqueMedia(ytDlpResult.videos ?? []),
      warnings: ytDlpResult.warnings
    };
  } catch (error) {
    warnings.push(`yt-dlp extractor failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const result = {
    sourceUrl,
    images: [],
    videos: [],
    warnings: []
  };
  const nextWarnings = warnings.concat(result.warnings);
  if (!result.images.length && !result.videos.length) {
    nextWarnings.push("No media URLs were discovered with yt-dlp. Check browser cookies or update yt-dlp.");
  }

  return {
    ...result,
    warnings: uniqueStrings(nextWarnings)
  };
}

async function scrapeInstagramHtml(sourceUrl: string): Promise<InstagramScrapeResult> {
  const response = await fetch(sourceUrl, {
    headers: INSTAGRAM_HEADERS,
    redirect: "follow",
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`Instagram returned HTTP ${response.status}.`);
  }

  const html = await response.text();
  const warnings = detectInstagramWarnings(html);
  const captionText = firstNonEmpty([
    readMetaContent(html, "og:description"),
    readMetaContent(html, "twitter:description")
  ]);
  const images = uniqueMedia([
    ...metaMedia(html, "og:image", "image"),
    ...metaMedia(html, "twitter:image", "image"),
    ...scanEmbeddedMediaUrls(html, "image")
  ]);
  const videos = uniqueMedia([
    ...metaMedia(html, "og:video", "video"),
    ...metaMedia(html, "og:video:url", "video"),
    ...scanEmbeddedMediaUrls(html, "video")
  ]);

  return {
    sourceUrl,
    captionText,
    images,
    videos,
    warnings
  };
}

async function scrapeInstagramWithYtDlp(sourceUrl: string): Promise<Omit<InstagramScrapeResult, "sourceUrl">> {
  const { info, usedBrowserCookies } = await runYtDlp(sourceUrl);
  const videos = ytDlpVideos(info);
  const images = ytDlpImages(info);
  const warnings = videos.length
    ? ["Resolved the best MP4 for each Instagram video item with yt-dlp."]
    : ["yt-dlp did not return any video formats."];
  if (usedBrowserCookies) warnings.push(`Used ${ytDlpCookieBrowser()} browser cookies for Instagram auth.`);

  return {
    captionText: typeof info.description === "string" ? info.description : typeof info.title === "string" ? info.title : undefined,
    images,
    videos,
    warnings
  };
}

async function runYtDlp(sourceUrl: string) {
  if (!ytDlpCookieBrowser()) {
    const info = await runYtDlpCommand(sourceUrl, false);
    return { info, usedBrowserCookies: false };
  }

  try {
    const info = await runYtDlpCommand(sourceUrl, true);
    return { info, usedBrowserCookies: true };
  } catch (cookieError) {
    try {
      const info = await runYtDlpCommand(sourceUrl, false);
      return { info, usedBrowserCookies: false };
    } catch {
      throw cookieError;
    }
  }
}

function runYtDlpCommand(sourceUrl: string, useBrowserCookies: boolean) {
  return new Promise<YtDlpInfo>((resolve, reject) => {
    const args = ["--dump-single-json", "--no-warnings"];
    const cookieBrowser = ytDlpCookieBrowser();
    if (useBrowserCookies && cookieBrowser) args.push("--cookies-from-browser", cookieBrowser);
    args.push(sourceUrl);

    const child = spawn(resolveYtDlpPath(), args, {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Timed out while running yt-dlp."));
    }, 30_000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `yt-dlp exited with code ${code}.`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as YtDlpInfo);
      } catch (error) {
        reject(new Error(`Could not parse yt-dlp JSON: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  });
}

function ytDlpCookieBrowser() {
  return process.env.IGDB_YTDLP_COOKIES_BROWSER;
}

function resolveYtDlpPath() {
  const configuredBinary = process.env.IGDB_YTDLP_PATH;
  if (configuredBinary) return configuredBinary;

  const projectBinary = path.join(process.cwd(), "node_modules", "yt-dlp-exec", "bin", "yt-dlp");
  if (existsSync(projectBinary)) return projectBinary;

  return "yt-dlp";
}

function ytDlpVideos(info: YtDlpInfo) {
  const entries = ytDlpEntries(info);
  if (entries.length) {
    return uniqueMedia(
      entries.flatMap((entry, index) => {
        const video = ytDlpBestVideo(entry, `yt-dlp:item-${index + 1}`);
        return video ? [video] : [];
      })
    );
  }

  const video = ytDlpBestVideo(info, "yt-dlp");
  return video ? [video] : [];
}

function ytDlpBestVideo(info: YtDlpInfo, source: string): InstagramMediaReference | undefined {
  const directVideo =
    typeof info.url === "string" && isAllowedInstagramMediaUrl(info.url) && info.ext === "mp4"
      ? {
          url: info.url,
          kind: "video" as const,
          contentType: "video/mp4",
          width: numberValue(info.width),
          height: numberValue(info.height),
          source: `${source}:selected`
        }
      : undefined;

  const formats = Array.isArray(info.formats) ? (info.formats as YtDlpFormat[]) : [];
  const bestFormat = formats
    .filter((format) => typeof format.url === "string" && isAllowedInstagramMediaUrl(format.url))
    .filter((format) => {
      const ext = typeof format.ext === "string" ? format.ext.toLowerCase() : "";
      const vcodec = typeof format.vcodec === "string" ? format.vcodec : "";
      return ext === "mp4" && vcodec !== "none";
    })
    .sort((left, right) => videoScore(right) - videoScore(left))[0];

  if (!bestFormat) return directVideo;

  const formatVideo = {
    url: bestFormat.url as string,
    kind: "video" as const,
    contentType: "video/mp4",
    width: numberValue(bestFormat.width),
    height: numberValue(bestFormat.height),
    source: typeof bestFormat.format_id === "string" ? `${source}:${bestFormat.format_id}` : source
  };

  if (!directVideo) return formatVideo;
  return videoScore(bestFormat) > ((directVideo.width ?? 0) * (directVideo.height ?? 0) || 0) ? formatVideo : directVideo;
}

function ytDlpEntries(info: YtDlpInfo) {
  return Array.isArray(info.entries) ? (info.entries as YtDlpInfo[]).filter(Boolean) : [];
}

function ytDlpImages(info: YtDlpInfo) {
  const entries = ytDlpEntries(info);
  if (entries.length) {
    return uniqueMedia(entries.flatMap((entry, index) => ytDlpImagesForInfo(entry, `yt-dlp:item-${index + 1}:thumbnail`)));
  }
  return ytDlpImagesForInfo(info, "yt-dlp:thumbnail");
}

function ytDlpImagesForInfo(info: YtDlpInfo, source: string) {
  if (!Array.isArray(info.thumbnails)) return [];
  return uniqueMedia(
    (info.thumbnails as Array<{ url?: unknown; width?: unknown; height?: unknown }>)
      .filter((thumbnail) => typeof thumbnail.url === "string" && isAllowedInstagramMediaUrl(thumbnail.url))
      .map((thumbnail) => ({
        url: thumbnail.url as string,
        kind: "image" as const,
        width: numberValue(thumbnail.width),
        height: numberValue(thumbnail.height),
        source
      }))
  );
}

function videoScore(format: YtDlpFormat) {
  return (numberValue(format.width) ?? 0) * (numberValue(format.height) ?? 0) + (numberValue(format.tbr) ?? 0);
}

function detectInstagramWarnings(html: string) {
  const warnings: string[] = [];
  if (html.includes("PolarisErrorRoot") || html.includes("httpErrorPage")) {
    warnings.push("Instagram served an error page shell for this URL.");
  }
  if (html.includes("Login • Instagram") || html.includes("Log in to Instagram")) {
    warnings.push("Instagram served a login gate instead of public media.");
  }
  if (html.includes("fail_ssr_disabled")) {
    warnings.push("Instagram disabled server-rendered page data for this request.");
  }
  return warnings;
}

function metaMedia(html: string, property: string, kind: InstagramMediaReference["kind"]) {
  const content = readMetaContent(html, property);
  return content ? [{ url: content, kind, source: "html:meta" }] : [];
}

function readMetaContent(html: string, property: string) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i");
  const reversePattern = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`, "i");
  const match = html.match(pattern) ?? html.match(reversePattern);
  return match?.[1] ? decodeHtmlEntities(match[1]) : undefined;
}

function scanEmbeddedMediaUrls(html: string, kind: InstagramMediaReference["kind"]) {
  const candidates = html.match(/https?(?:\\u0025[0-9A-Fa-f]{2}|\\\/|[^"'<>\\\s])+/g) ?? [];
  const out: InstagramMediaReference[] = [];
  for (const candidate of candidates) {
    const url = normalizeEmbeddedUrl(candidate);
    if (!url || !isAllowedInstagramMediaUrl(url) || isStaticInstagramAsset(url)) continue;
    if (kind === "image" && !looksLikeImageUrl(url)) continue;
    if (kind === "video" && !looksLikeVideoUrl(url)) continue;
    out.push({ url, kind, source: "html:embedded" });
  }
  return out;
}

function normalizeEmbeddedUrl(rawUrl: string) {
  try {
    const cleaned = decodeHtmlEntities(rawUrl)
      .replaceAll("\\/", "/")
      .replaceAll("\\u0026", "&")
      .replaceAll("\\u0025", "%");
    return new URL(cleaned).toString();
  } catch {
    return undefined;
  }
}

function uniqueMedia(media: InstagramMediaReference[]) {
  const seen = new Set<string>();
  return media.filter((item) => {
    if (seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}

function isStaticInstagramAsset(rawUrl: string) {
  const url = new URL(rawUrl);
  return url.hostname.startsWith("static.") || url.pathname.includes("/rsrc.php/");
}

function looksLikeImageUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  return /\.(avif|jpe?g|png|webp)(?:$|[?#])/i.test(url.pathname) || url.searchParams.has("se");
}

function looksLikeVideoUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  return /\.(mp4|mov|m4v)(?:$|[?#])/i.test(url.pathname);
}

function firstNonEmpty(values: Array<string | undefined>) {
  return values.find((value) => value && value.trim().length > 0);
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function decodeHtmlEntities(value: string) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#039;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}
