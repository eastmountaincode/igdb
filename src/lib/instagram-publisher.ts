import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildInstagramCaption, type InstagramFileMetadata } from "@/instagram-caption";
import { AUDIO_PROBE_SAMPLE_RATE, synthesizeDtmfProbePackets } from "@/audio-codec";
import { findPublishedMediaByRequestId, recordPublishedMedia } from "@/lib/instagram-media-index";

const API_VERSION = "v24.0";
const INSTAGRAM_ACCOUNT_ID = "28189490653969128";
const INSTAGRAM_USERNAME = "normal_shopkeep";
const JOB_ROOT = join(process.cwd(), ".instagram-uploads");
const execFileAsync = promisify(execFile);

type StagedJob = {
  id: string;
  mediaToken: string;
  caption: string;
  files: string[];
  totalParts: number;
  displayCover?: boolean;
  publishRequestId?: string;
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
  audioPayloads?: File[];
  metadata: InstagramFileMetadata;
  mediaBaseUrl: string;
}) {
  const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN_NORMAL_SHOPKEEP;
  if (!accessToken) throw new Error("Instagram publishing is not configured.");

  const job = await stageJob(input.videos, input.audioPayloads ?? [], input.metadata);
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
      childIds.push(child.id);
    }
    await Promise.all(childIds.map((childId) => waitForContainer(childId, accessToken)));

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
    await recordPublishedMedia(published.id, false);
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

export async function stageInstagramVideoPart(input: {
  video: File;
  audioPayload?: File;
  partIndex: number;
  totalParts: number;
  uploadId?: string;
  uploadToken?: string;
  displayCover?: boolean;
}) {
  const id = input.uploadId ? safeSegment(input.uploadId) : randomUUID();
  const directory = join(JOB_ROOT, id);
  await mkdir(directory, { recursive: true });

  let job: StagedJob;
  if (input.uploadId) {
    job = JSON.parse(await readFile(join(directory, "job.json"), "utf8")) as StagedJob;
    if (job.mediaToken !== input.uploadToken || job.totalParts !== input.totalParts) throw new Error("Invalid upload session.");
  } else {
    job = {
      id,
      mediaToken: randomBytes(24).toString("hex"),
      caption: "",
      files: [],
      totalParts: input.totalParts,
      displayCover: input.displayCover === true,
      createdAt: new Date().toISOString()
    };
  }

  const fileName = `part-${String(input.partIndex + 1).padStart(2, "0")}.mp4`;
  const inputPath = join(directory, `input-${String(input.partIndex + 1).padStart(2, "0")}.mp4`);
  await writeFile(inputPath, Buffer.from(await input.video.arrayBuffer()));
  try {
    if (input.audioPayload) {
      await muxDtmfAudio(
        inputPath,
        join(directory, fileName),
        new Uint8Array(await input.audioPayload.arrayBuffer()),
        directory,
        input.partIndex
      );
    } else {
      await writeFile(join(directory, fileName), Buffer.from(await input.video.arrayBuffer()));
    }
  } finally {
    await rm(inputPath, { force: true });
  }

  if (!job.files.includes(fileName)) job.files.push(fileName);
  job.files.sort();
  await writeFile(join(directory, "job.json"), JSON.stringify(job));
  return { uploadId: job.id, uploadToken: job.mediaToken, uploadedParts: job.files.length };
}

export async function publishStagedInstagramVideos(input: {
  uploadId: string;
  uploadToken: string;
  metadata: InstagramFileMetadata;
  mediaBaseUrl: string;
  publishRequestId?: string;
}) {
  const id = safeSegment(input.uploadId);
  const directory = join(JOB_ROOT, id);
  const lockPath = join(directory, ".publishing");
  try {
    const lock = await open(lockPath, "wx");
    await lock.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("This upload is already being published.");
    throw error;
  }
  try {
    const job = JSON.parse(await readFile(join(directory, "job.json"), "utf8")) as StagedJob;
    if (job.mediaToken !== input.uploadToken) throw new Error("Invalid upload session.");
    if (job.files.length !== job.totalParts) throw new Error("Not all video parts finished uploading.");
    job.publishRequestId = input.publishRequestId;
    job.caption = buildInstagramCaption(input.metadata);
    await writeFile(join(directory, "job.json"), JSON.stringify(job));
    return await publishStagedJob(job, input.mediaBaseUrl);
  } catch (error) {
    await rm(lockPath, { force: true });
    throw error;
  }
}

export async function readStagedMedia(jobId: string, fileName: string, token: string) {
  const safeJobId = safeSegment(jobId);
  const safeFileName = safeSegment(fileName);
  const metadata = JSON.parse(await readFile(join(JOB_ROOT, safeJobId, "job.json"), "utf8")) as StagedJob;
  if (metadata.mediaToken !== token || !metadata.files.includes(safeFileName)) throw new Error("Not found");
  return readFile(join(JOB_ROOT, safeJobId, safeFileName));
}

async function stageJob(videos: File[], audioPayloads: File[], metadata: InstagramFileMetadata): Promise<StagedJob> {
  const id = randomUUID();
  const directory = join(JOB_ROOT, id);
  await mkdir(directory, { recursive: true });
  const files: string[] = [];

  for (let index = 0; index < videos.length; index += 1) {
    const fileName = `part-${String(index + 1).padStart(2, "0")}.mp4`;
    const inputPath = join(directory, `input-${String(index + 1).padStart(2, "0")}.mp4`);
    await writeFile(inputPath, Buffer.from(await videos[index].arrayBuffer()));
    if (audioPayloads[index]) {
      await muxDtmfAudio(inputPath, join(directory, fileName), new Uint8Array(await audioPayloads[index].arrayBuffer()), directory, index);
      await rm(inputPath, { force: true });
    } else {
      await writeFile(join(directory, fileName), Buffer.from(await videos[index].arrayBuffer()));
      await rm(inputPath, { force: true });
    }
    files.push(fileName);
  }

  const job: StagedJob = {
    id,
    mediaToken: randomBytes(24).toString("hex"),
    caption: buildInstagramCaption(metadata),
    files,
    totalParts: files.length,
    createdAt: new Date().toISOString()
  };
  await writeFile(join(directory, "job.json"), JSON.stringify(job));
  return job;
}

async function publishStagedJob(job: StagedJob, mediaBaseUrl: string) {
  const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN_NORMAL_SHOPKEEP;
  if (!accessToken) throw new Error("Instagram publishing is not configured.");
  try {
    if (job.publishRequestId) {
      const existing = await findPublishedMediaByRequestId(job.publishRequestId);
      if (existing) {
        const permalink = existing.permalink || await waitForPublishedPermalink(existing.mediaId, accessToken);
        if (!existing.permalink) {
          await recordPublishedMedia(existing.mediaId, existing.displayCover, {
            requestId: job.publishRequestId,
            permalink,
            parts: existing.parts ?? job.totalParts
          });
        }
        console.log("[instagram-publish] returning existing publication", { requestId: job.publishRequestId, mediaId: existing.mediaId });
        return {
          mediaId: existing.mediaId,
          permalink,
          username: INSTAGRAM_USERNAME,
          caption: job.caption,
          parts: existing.parts ?? job.totalParts
        };
      }
    }
    console.log("[instagram-publish] starting", { jobId: job.id, requestId: job.publishRequestId, parts: job.files.length, displayCover: job.displayCover === true });
    const childIds: string[] = [];
    for (let index = 0; index < job.files.length; index += 1) {
      const mediaUrl = `${mediaBaseUrl}/api/instagram/media/${job.id}/${encodeURIComponent(job.files[index])}?token=${job.mediaToken}`;
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
    console.log("[instagram-publish] media published", { jobId: job.id, requestId: job.publishRequestId, mediaId: published.id });
    await recordPublishedMedia(published.id, job.displayCover === true, {
      requestId: job.publishRequestId,
      parts: childIds.length
    });
    const permalink = await waitForPublishedPermalink(published.id, accessToken);
    await recordPublishedMedia(published.id, job.displayCover === true, {
      requestId: job.publishRequestId,
      permalink,
      parts: childIds.length
    });
    console.log("[instagram-publish] permalink resolved", { mediaId: published.id, permalink });
    return {
      mediaId: published.id,
      permalink,
      username: INSTAGRAM_USERNAME,
      caption: job.caption,
      parts: childIds.length
    };
  } finally {
    await rm(join(JOB_ROOT, job.id), { recursive: true, force: true });
  }
}

async function waitForPublishedPermalink(mediaId: string, accessToken: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const media = await graphGet(`/${mediaId}`, {
      fields: "id,permalink,media_type,media_product_type,username"
    }, accessToken);
    if (media.permalink) return media.permalink;
    if (media.error && attempt >= 4) throw graphError(media, "Instagram published the post but did not return its URL.");
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error("Instagram published the post but its URL is still processing. Retrying will return the same post.");
}

export async function muxDtmfAudio(inputPath: string, outputPath: string, payload: Uint8Array, directory: string, index: number) {
  const packets: Uint8Array[] = [];
  for (let offset = 0; offset < payload.length; offset += 16) {
    packets.push(payload.slice(offset, offset + 16));
  }
  const samples = synthesizeDtmfProbePackets(packets);
  const wavPath = join(directory, `audio-${String(index + 1).padStart(2, "0")}.wav`);
  await writeFile(wavPath, encodeMonoPcm16Wav(samples, AUDIO_PROBE_SAMPLE_RATE));
  try {
    await execFileAsync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", inputPath,
      "-i", wavPath,
      "-map", "0:v:0",
      "-map", "1:a:0",
      "-c:v", "copy",
      "-c:a", "aac",
      "-b:a", "128k",
      "-movflags", "+faststart",
      outputPath
    ]);
  } finally {
    await rm(wavPath, { force: true });
  }
}

function encodeMonoPcm16Wav(samples: Float32Array, sampleRate: number) {
  const dataBytes = samples.length * 2;
  const buffer = Buffer.allocUnsafe(44 + dataBytes);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    buffer.writeInt16LE(Math.round(sample * (sample < 0 ? 32768 : 32767)), 44 + index * 2);
  }
  return buffer;
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
