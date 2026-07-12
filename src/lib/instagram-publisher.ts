import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { buildInstagramCaption, type InstagramFileMetadata } from "@/instagram-caption";

const API_VERSION = "v24.0";
const INSTAGRAM_ACCOUNT_ID = "28189490653969128";
const INSTAGRAM_USERNAME = "normal_shopkeep";
const JOB_ROOT = join(process.cwd(), ".instagram-uploads");

type StagedJob = {
  id: string;
  mediaToken: string;
  caption: string;
  files: string[];
  createdAt: string;
};

type GraphResponse = {
  id?: string;
  status_code?: "IN_PROGRESS" | "FINISHED" | "ERROR" | "EXPIRED";
  status?: string;
  permalink?: string;
  error?: { message?: string; code?: number };
};

export async function publishInstagramVideos(input: {
  videos: File[];
  metadata: InstagramFileMetadata;
  mediaBaseUrl: string;
}) {
  const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN_NORMAL_SHOPKEEP;
  if (!accessToken) throw new Error("Instagram publishing is not configured.");

  const job = await stageJob(input.videos, input.metadata);
  try {
    const childIds: string[] = [];
    for (let index = 0; index < job.files.length; index += 1) {
      const mediaUrl = `${input.mediaBaseUrl}/api/instagram/media/${job.id}/${encodeURIComponent(job.files[index])}?token=${job.mediaToken}`;
      const child = await graphPost(`/${INSTAGRAM_ACCOUNT_ID}/media`, {
        media_type: job.files.length === 1 ? "REELS" : "VIDEO",
        video_url: mediaUrl,
        ...(job.files.length === 1
          ? { caption: job.caption, share_to_feed: "true" }
          : { is_carousel_item: "true" })
      }, accessToken);
      if (!child.id) throw graphError(child, `Instagram rejected video ${index + 1}.`);
      await waitForContainer(child.id, accessToken);
      childIds.push(child.id);
    }

    let creationId = childIds[0];
    if (childIds.length > 1) {
      const carousel = await graphPost(`/${INSTAGRAM_ACCOUNT_ID}/media`, {
        media_type: "CAROUSEL",
        children: childIds.join(","),
        caption: job.caption
      }, accessToken);
      if (!carousel.id) throw graphError(carousel, "Instagram rejected the carousel.");
      await waitForContainer(carousel.id, accessToken);
      creationId = carousel.id;
    }

    const published = await graphPost(`/${INSTAGRAM_ACCOUNT_ID}/media_publish`, { creation_id: creationId }, accessToken);
    if (!published.id) throw graphError(published, "Instagram did not publish the post.");

    const media = await graphGet(`/${published.id}`, {
      fields: "id,permalink,media_type,media_product_type,username"
    }, accessToken);
    return {
      mediaId: published.id,
      permalink: media.permalink,
      username: INSTAGRAM_USERNAME,
      caption: job.caption,
      parts: childIds.length
    };
  } finally {
    await rm(join(JOB_ROOT, job.id), { recursive: true, force: true });
  }
}

export async function readStagedMedia(jobId: string, fileName: string, token: string) {
  const safeJobId = safeSegment(jobId);
  const safeFileName = safeSegment(fileName);
  const metadata = JSON.parse(await readFile(join(JOB_ROOT, safeJobId, "job.json"), "utf8")) as StagedJob;
  if (metadata.mediaToken !== token || !metadata.files.includes(safeFileName)) throw new Error("Not found");
  return readFile(join(JOB_ROOT, safeJobId, safeFileName));
}

async function stageJob(videos: File[], metadata: InstagramFileMetadata): Promise<StagedJob> {
  const id = randomUUID();
  const directory = join(JOB_ROOT, id);
  await mkdir(directory, { recursive: true });
  const files: string[] = [];

  for (let index = 0; index < videos.length; index += 1) {
    const fileName = `part-${String(index + 1).padStart(2, "0")}.mp4`;
    await writeFile(join(directory, fileName), Buffer.from(await videos[index].arrayBuffer()));
    files.push(fileName);
  }

  const job: StagedJob = {
    id,
    mediaToken: randomBytes(24).toString("hex"),
    caption: buildInstagramCaption(metadata),
    files,
    createdAt: new Date().toISOString()
  };
  await writeFile(join(directory, "job.json"), JSON.stringify(job));
  return job;
}

async function waitForContainer(containerId: string, accessToken: string) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const response = await graphGet(`/${containerId}`, { fields: "status_code,status" }, accessToken);
    if (response.status_code === "FINISHED") return;
    if (response.status_code === "ERROR" || response.status_code === "EXPIRED") {
      throw graphError(response, "Instagram could not process the video.");
    }
    await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  throw new Error("Instagram video processing timed out.");
}

async function graphPost(path: string, values: Record<string, string>, accessToken: string) {
  const body = new URLSearchParams({ ...values, access_token: accessToken });
  const response = await fetch(`https://graph.instagram.com/${API_VERSION}${path}`, { method: "POST", body });
  return response.json() as Promise<GraphResponse>;
}

async function graphGet(path: string, values: Record<string, string>, accessToken: string) {
  const query = new URLSearchParams({ ...values, access_token: accessToken });
  const response = await fetch(`https://graph.instagram.com/${API_VERSION}${path}?${query}`);
  return response.json() as Promise<GraphResponse>;
}

function graphError(response: GraphResponse, fallback: string) {
  return new Error(response.error?.message || response.status || fallback);
}

function safeSegment(value: string) {
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) throw new Error("Invalid path");
  return value;
}
