import { decompressFrames, parseGIF, type ParsedFrame } from "gifuct-js";
import { CANVAS_SIZE, VIDEO_BITRATE, type EncodeVideoProgress } from "@/codec";
import { formatCaptionBytes, type InstagramFileMetadata } from "@/instagram-caption";

const COVER_DURATION_SECONDS = 8;
const COVER_FPS = 15;

export async function encodeGifCoverVideo(
  gifFile: File | null,
  metadata: InstagramFileMetadata,
  onProgress?: (progress: EncodeVideoProgress) => void
) {
  await document.fonts.load('38px "Los Angeles"');
  if (gifFile && !gifFile.type.includes("gif") && !gifFile.name.toLowerCase().endsWith(".gif")) {
    throw new Error("The cover must be a GIF.");
  }
  onProgress?.({ phase: gifFile ? "Reading GIF" : "Preparing display", completed: 0, total: 1 });
  const parsedGif = gifFile ? parseGIF(await gifFile.arrayBuffer()) : null;
  const frames = parsedGif ? decompressFrames(parsedGif, true) : [];
  if (gifFile && !frames.length) throw new Error("The GIF contains no readable frames.");
  const composedFrames = parsedGif ? composeGifFrames(frames, parsedGif.lsd.width, parsedGif.lsd.height) : [blankFrame()];
  const durations = frames.length ? frames.map((frame) => Math.max(20, frame.delay || 100)) : [1000];
  const cycleDuration = durations.reduce((sum, duration) => sum + duration, 0);

  const { BufferTarget, CanvasSource, Mp4OutputFormat, Output, canEncodeVideo, getFirstEncodableVideoCodec } = await import("mediabunny");
  const format = new Mp4OutputFormat({ fastStart: "in-memory" });
  const codec = await getFirstEncodableVideoCodec(format.getSupportedVideoCodecs().filter((value) => value === "avc"), {
    width: CANVAS_SIZE,
    height: CANVAS_SIZE,
    bitrate: VIDEO_BITRATE
  });
  if (!codec) throw new Error("This browser cannot encode the GIF cover as H.264 video.");
  const constantBitrate = await canEncodeVideo(codec, {
    width: CANVAS_SIZE,
    height: CANVAS_SIZE,
    bitrate: VIDEO_BITRATE,
    bitrateMode: "constant",
    latencyMode: "realtime"
  });
  const stage = document.createElement("canvas");
  stage.width = CANVAS_SIZE;
  stage.height = CANVAS_SIZE;
  const context = requiredContext(stage);
  const target = new BufferTarget();
  const output = new Output({ format, target });
  const source = new CanvasSource(stage, {
    codec,
    bitrate: VIDEO_BITRATE,
    bitrateMode: constantBitrate ? "constant" : "variable",
    latencyMode: "realtime"
  });
  output.addVideoTrack(source, { frameRate: COVER_FPS });
  await output.start();

  const totalFrames = COVER_DURATION_SECONDS * COVER_FPS;
  const frameDuration = 1 / COVER_FPS;
  onProgress?.({ phase: "Encoding GIF cover", completed: 0, total: totalFrames });
  for (let outputIndex = 0; outputIndex < totalFrames; outputIndex += 1) {
    const elapsedMs = ((outputIndex / COVER_FPS) * 1000) % cycleDuration;
    drawCoverFrame(context, composedFrames[frameIndexAtTime(durations, elapsedMs)], metadata, Boolean(gifFile));
    await source.add(outputIndex * frameDuration, frameDuration, { keyFrame: outputIndex % COVER_FPS === 0 });
    onProgress?.({ phase: "Encoding GIF cover", completed: outputIndex + 1, total: totalFrames });
    if (outputIndex % 8 === 7) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  source.close();
  onProgress?.({ phase: "Finalizing GIF cover", completed: totalFrames, total: totalFrames });
  await output.finalize();
  if (!target.buffer) throw new Error("GIF cover encoder did not produce a file.");
  return new Blob([target.buffer], { type: "video/mp4" });
}

function composeGifFrames(frames: ParsedFrame[], width: number, height: number) {
  const working = document.createElement("canvas");
  working.width = width;
  working.height = height;
  const context = requiredContext(working);
  const composed: HTMLCanvasElement[] = [];

  for (const frame of frames) {
    const before = frame.disposalType === 3 ? context.getImageData(0, 0, width, height) : null;
    const patch = context.createImageData(frame.dims.width, frame.dims.height);
    patch.data.set(frame.patch);
    context.putImageData(patch, frame.dims.left, frame.dims.top);
    const snapshot = document.createElement("canvas");
    snapshot.width = width;
    snapshot.height = height;
    requiredContext(snapshot).drawImage(working, 0, 0);
    composed.push(snapshot);
    if (frame.disposalType === 2) {
      context.clearRect(frame.dims.left, frame.dims.top, frame.dims.width, frame.dims.height);
    } else if (frame.disposalType === 3 && before) {
      context.putImageData(before, 0, 0);
    }
  }
  return composed;
}

function drawCoverFrame(context: CanvasRenderingContext2D, gifFrame: HTMLCanvasElement, metadata: InstagramFileMetadata, hasGif: boolean) {
  context.fillStyle = "#000";
  context.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  const maxWidth = 520;
  const maxHeight = 340;
  if (hasGif) {
    const scale = Math.min(maxWidth / gifFrame.width, maxHeight / gifFrame.height);
    const width = Math.max(1, Math.round(gifFrame.width * scale));
    const height = Math.max(1, Math.round(gifFrame.height * scale));
    context.imageSmoothingEnabled = false;
    context.drawImage(gifFrame, Math.round((CANVAS_SIZE - width) / 2), 70 + Math.round((maxHeight - height) / 2), width, height);
  }

  context.fillStyle = "#fff";
  context.textBaseline = "top";
  const lines = [
    `File name: ${metadata.name}`,
    `File type: ${metadata.type || "application/octet-stream"}`,
    `File size: ${formatCaptionBytes(metadata.size)}`
  ];
  lines.forEach((line, index) => {
    context.font = fitFont(context, line, 560, hasGif ? 30 : 38);
    context.fillText(line, 80, (hasGif ? 470 : 270) + index * (hasGif ? 48 : 64));
  });
}

function fitFont(context: CanvasRenderingContext2D, text: string, maxWidth: number, startingSize: number) {
  let size = startingSize;
  while (size > 16) {
    const font = `${size}px "Los Angeles", "Times New Roman", Times, serif`;
    context.font = font;
    if (context.measureText(text).width <= maxWidth) return font;
    size -= 1;
  }
  return `16px "Los Angeles", "Times New Roman", Times, serif`;
}

function blankFrame() {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  return canvas;
}

function frameIndexAtTime(durations: number[], timeMs: number) {
  let elapsed = 0;
  for (let index = 0; index < durations.length; index += 1) {
    elapsed += durations[index];
    if (timeMs < elapsed) return index;
  }
  return durations.length - 1;
}

function requiredContext(canvas: HTMLCanvasElement) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Canvas is unavailable.");
  return context;
}
