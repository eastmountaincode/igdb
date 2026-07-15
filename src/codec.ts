import {
  AUDIO_PROBE_DURATION_SECONDS,
  AUDIO_PROBE_PAYLOAD_BYTES,
  audioProbeByteCapacityForDuration,
  audioProbeDurationForByteLength,
  decodeDtmfProbeBytePacketsFromFile
} from "./audio-codec";

export const CANVAS_SIZE = 720;
export const CELL_SIZE = 4;
export const GRID_ORIGIN = 48;
export const GRID_CELLS = 156;
export const MAX_POST_IMAGES = 8;
export const palette = [
  [16, 16, 16],
  [246, 246, 246],
  [220, 38, 38],
  [37, 99, 235],
  [22, 163, 74],
  [245, 128, 32]
] as const;
const SYMBOL_COUNT = GRID_CELLS * GRID_CELLS;
const SYMBOL_RADIX = palette.length;
const SYMBOL_BLOCK_BYTES = 8;
const SYMBOL_BLOCK_SIZE = 25;
export const HEADER_BYTES = 512;
export const RAW_CHUNK_BYTES = Math.floor(SYMBOL_COUNT / SYMBOL_BLOCK_SIZE) * SYMBOL_BLOCK_BYTES;
export const PAYLOAD_BYTES_PER_IMAGE = RAW_CHUNK_BYTES - HEADER_BYTES;
export const VIDEO_FPS = 30;
export const VIDEO_REPEAT_FRAMES = 3;
const INSTAGRAM_MIN_VIDEO_SECONDS = 3;
export const VIDEO_PARITY_GROUP_SIZE = 16;
export const VIDEO_TARGET_SECONDS = 55;
const AUDIO_PACKETS_PER_VIDEO = Math.floor(VIDEO_TARGET_SECONDS / AUDIO_PROBE_DURATION_SECONDS);
const AUDIO_PAYLOAD_BYTES = AUDIO_PACKETS_PER_VIDEO * AUDIO_PROBE_PAYLOAD_BYTES;
export const VIDEO_BITRATE = 6_000_000;
export const VIDEO_EFFECTIVE_BYTES_PER_SECOND = Math.floor(
  (PAYLOAD_BYTES_PER_IMAGE * VIDEO_FPS * VIDEO_PARITY_GROUP_SIZE) /
    (VIDEO_REPEAT_FRAMES * (VIDEO_PARITY_GROUP_SIZE + 1))
);
export const VIDEO_TARGET_BYTES =
  maxDataChunksForTargetVideo(VIDEO_REPEAT_FRAMES, VIDEO_TARGET_SECONDS) * PAYLOAD_BYTES_PER_IMAGE;

export type EncodedImage = {
  canvas: HTMLCanvasElement;
  caption: string;
  chunkIndex: number;
  totalChunks: number;
  payloadBytes: number;
};

export type DecodeResult = {
  ok: boolean;
  kind: ChunkKind;
  fileName: string;
  mimeType: string;
  fileSize: number;
  fileHash: string;
  chunkIndex: number;
  totalChunks: number;
  payload: Uint8Array;
  message: string;
  parityMemberIndexes?: number[];
  parityMemberLengths?: number[];
};

export type FileManifest = {
  protocol: "fliptable-igdb";
  version: 1;
  codec: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  totalChunks: number;
  maxCarouselImages: number;
  bytesPerImage: number;
  generatedAt: string;
};

export type EncodedVideo = {
  blob: Blob;
  audioPayload?: Blob;
  url: string;
  frameCount: number;
  chunkCount: number;
  payloadBytes: number;
  fileBytes: number;
  durationSeconds: number;
  caption: string;
  segmentIndex: number;
  totalSegments: number;
  dataChunkStart: number;
  dataChunkEnd: number;
  dataChunkCount: number;
  audioPacketCount?: number;
  audioPayloadBytes?: number;
};

export type EncodeVideoProgress = {
  phase: string;
  completed: number;
  total: number;
};

export type DecodeVideoProgress = {
  phase: string;
  completed: number;
  total: number;
};

type Header = {
  kind?: ChunkKind;
  fileName: string;
  mimeType: string;
  fileSize: number;
  fileHash: string;
  chunkIndex: number;
  totalChunks: number;
  payloadLength: number;
  chunkCrc: number;
  parityMemberIndexes?: number[];
  parityMemberLengths?: number[];
  parityStartIndex?: number;
  parityMemberCount?: number;
  parityLastMemberLength?: number;
};

type CompactHeader = {
  v: 2;
  k: "d" | "x";
  n: string;
  m: string;
  s: number;
  h: string;
  i: number;
  t: number;
  l: number;
  c: number;
  a?: number[];
  b?: number[];
  p?: number;
  q?: number;
  r?: number;
};

type ChunkKind = "data" | "xor";
type FrameSource = HTMLCanvasElement | ImageBitmap;

type RenderChunkJob = {
  order: number;
  header: Header;
  payload: Uint8Array;
};

type EncodeSegmentInput = {
  bytes: Uint8Array;
  file: File;
  fileHash: string;
  totalChunks: number;
  totalSegments: number;
  maxDataChunksPerVideo: number;
  segmentIndex: number;
  repeatFrames: number;
  onProgress?: (progress: EncodeVideoProgress) => void;
};

type EncodeHybridSegmentInput = {
  bytes: Uint8Array;
  file: File;
  fileHash: string;
  totalChunks: number;
  totalSegments: number;
  segment: HybridSegmentPlan;
  repeatFrames: number;
  onProgress?: (progress: EncodeVideoProgress) => void;
};

type HybridSegmentPlan = {
  segmentIndex: number;
  visualChunks: Array<{
    chunkIndex: number;
    payloadStart: number;
    payloadLength: number;
  }>;
  audioChunks: Array<{
    chunkIndex: number;
    payloadStart: number;
    payloadLength: number;
  }>;
};

type WorkerCodecProfile = {
  canvasSize: number;
  cellSize: number;
  gridOrigin: number;
  gridCells: number;
  palette: number[][];
  headerBytes: number;
  rawChunkBytes: number;
  symbolCount: number;
  symbolRadix: number;
};

type DecodeWorkerResponse = {
  id: number;
  result?: SerializedDecodeResult;
  error?: string;
};

type SerializedDecodeResult = Omit<DecodeResult, "payload"> & {
  payload: ArrayBuffer;
};

const MAGIC = [70, 84, 73, 71]; // FTIG
const VERSION = 1;
const ENCODE_WORKER_COUNT = 2;
const SEGMENT_ENCODE_CONCURRENCY = 2;
const DECODE_WORKER_COUNT = 2;
const DECODE_WORKER_BACKLOG = DECODE_WORKER_COUNT * 3;
const ENABLE_ENCODE_WORKERS = false;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function capacitySummary() {
  const videoMaxDataChunks = maxDataChunksForTargetVideo(VIDEO_REPEAT_FRAMES, VIDEO_TARGET_SECONDS);
  const videoMaxVisualPayloadBytes = videoMaxDataChunks * PAYLOAD_BYTES_PER_IMAGE;
  const videoMaxPayloadBytes = videoMaxVisualPayloadBytes;
  return {
    canvasSize: CANVAS_SIZE,
    cellSize: CELL_SIZE,
    gridCells: GRID_CELLS,
    colors: palette.length,
    rawBytesPerImage: RAW_CHUNK_BYTES,
    payloadBytesPerImage: PAYLOAD_BYTES_PER_IMAGE,
    maxPostImages: MAX_POST_IMAGES,
    maxPostBytes: PAYLOAD_BYTES_PER_IMAGE * MAX_POST_IMAGES,
    videoFps: VIDEO_FPS,
    videoRepeatFrames: VIDEO_REPEAT_FRAMES,
    videoTargetSeconds: VIDEO_TARGET_SECONDS,
    videoBitrate: VIDEO_BITRATE,
    videoBytesPerSecond: Math.floor(videoMaxPayloadBytes / VIDEO_TARGET_SECONDS),
    videoTargetBytes: videoMaxPayloadBytes,
    videoMaxDataChunks,
    videoMaxPayloadBytes,
    videoMaxVisualPayloadBytes,
    videoMaxAudioPayloadBytes: AUDIO_PAYLOAD_BYTES,
    videoMaxAudioPackets: AUDIO_PACKETS_PER_VIDEO,
    videoMaxTransmittedChunks: videoMaxDataChunks + Math.ceil(videoMaxDataChunks / VIDEO_PARITY_GROUP_SIZE)
  };
}

export function estimateVideoPlan(fileSize: number) {
  if (fileSize <= 0) {
    return {
      segments: 0,
      visualChunks: 0,
      audioPackets: 0,
      audioPayloadBytes: 0
    };
  }
  const segments = planHybridSegments(
    fileSize,
    maxDataChunksForTargetVideo(VIDEO_REPEAT_FRAMES, VIDEO_TARGET_SECONDS)
  );
  return {
    segments: segments.length,
    visualChunks: segments.reduce((sum, segment) => sum + segment.visualChunks.length, 0),
    audioPackets: segments.reduce((sum, segment) => sum + segment.audioChunks.length, 0),
    audioPayloadBytes: segments.reduce((sum, segment) => sum + segment.audioChunks.reduce((chunkSum, chunk) => chunkSum + chunk.payloadLength, 0), 0)
  };
}

export async function encodeFile(file: File): Promise<{ images: EncodedImage[]; manifest: FileManifest }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const totalChunks = Math.ceil(bytes.length / PAYLOAD_BYTES_PER_IMAGE);
  if (totalChunks > MAX_POST_IMAGES) {
    throw new Error(
      `${file.name} needs ${totalChunks} images. This demo caps one Instagram carousel at ${MAX_POST_IMAGES}; max payload is ${formatBytes(
        PAYLOAD_BYTES_PER_IMAGE * MAX_POST_IMAGES
      )}.`
    );
  }

  const fileHash = await sha256Hex(bytes);
  const manifest: FileManifest = {
    protocol: "fliptable-igdb",
    version: 1,
    codec: `colorgrid${palette.length}`,
    name: file.name,
    mime: file.type || "application/octet-stream",
    size: bytes.length,
    sha256: fileHash,
    totalChunks,
    maxCarouselImages: MAX_POST_IMAGES,
    bytesPerImage: PAYLOAD_BYTES_PER_IMAGE,
    generatedAt: new Date().toISOString()
  };

  const images: EncodedImage[] = [];
  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
    const start = chunkIndex * PAYLOAD_BYTES_PER_IMAGE;
    const payload = bytes.slice(start, start + PAYLOAD_BYTES_PER_IMAGE);
    const header: Header = {
      kind: "data",
      fileName: file.name,
      mimeType: file.type || "application/octet-stream",
      fileSize: bytes.length,
      fileHash,
      chunkIndex,
      totalChunks,
      payloadLength: payload.length,
      chunkCrc: crc32(payload)
    };
    const canvas = encodeChunk(header, payload);
    images.push({
      canvas,
      caption: captionForManifest(manifest, chunkIndex),
      chunkIndex,
      totalChunks,
      payloadBytes: payload.length
    });
  }

  return { images, manifest };
}

export async function encodeFileAsVideo(
  file: File,
  onProgress?: (progress: EncodeVideoProgress) => void
): Promise<EncodedVideo> {
  const videos = await encodeFileAsVideos(file, onProgress);
  return videos[0];
}

export async function encodeFileAsVideos(
  file: File,
  onProgress?: (progress: EncodeVideoProgress) => void
): Promise<EncodedVideo[]> {
  return encodeFileAsHybridVideos(file, onProgress);
}

async function encodeFileAsHybridVideos(
  file: File,
  onProgress?: (progress: EncodeVideoProgress) => void
): Promise<EncodedVideo[]> {
  onProgress?.({ phase: "Reading file", completed: 0, total: 1 });
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!bytes.length) throw new Error("Empty files cannot be encoded as video.");

  const fileHash = await sha256Hex(bytes);
  const maxVisualChunksPerVideo = maxDataChunksForTargetVideo(VIDEO_REPEAT_FRAMES, VIDEO_TARGET_SECONDS);
  const segments = planHybridSegments(bytes.length, maxVisualChunksPerVideo);
  const totalChunks = segments.reduce((sum, segment) => sum + segment.visualChunks.length, 0);
  const encodeSegment = (segmentIndex: number, segmentProgress?: (progress: EncodeVideoProgress) => void) =>
    encodeHybridVideoSegment({
      bytes,
      file,
      fileHash,
      totalChunks,
      totalSegments: segments.length,
      segment: segments[segmentIndex],
      repeatFrames: VIDEO_REPEAT_FRAMES,
      onProgress: segmentProgress
    });
  const segmentIndexes = segments.map((segment) => segment.segmentIndex);
  const videos =
    segments.length <= 1
      ? [await encodeSegment(0, onProgress)]
      : await encodeSegmentsInParallel(segmentIndexes, Math.min(SEGMENT_ENCODE_CONCURRENCY, segments.length), encodeSegment, onProgress);

  onProgress?.({ phase: "MP4 set ready", completed: videos.length, total: videos.length });
  return videos;
}

async function encodeFileAsVideosWithRepeat(
  file: File,
  repeatFrames: number,
  onProgress?: (progress: EncodeVideoProgress) => void
): Promise<EncodedVideo[]> {
  onProgress?.({ phase: "Reading file", completed: 0, total: 1 });
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!bytes.length) throw new Error("Empty files cannot be encoded as video.");

  const fileHash = await sha256Hex(bytes);
  const totalChunks = Math.ceil(bytes.length / PAYLOAD_BYTES_PER_IMAGE);
  const maxDataChunksPerVideo = maxDataChunksForTargetVideo(repeatFrames);
  const totalSegments = Math.max(1, Math.ceil(totalChunks / maxDataChunksPerVideo));

  const segmentIndexes = Array.from({ length: totalSegments }, (_, index) => index);
  const encodeSegment = (segmentIndex: number, segmentProgress?: (progress: EncodeVideoProgress) => void) =>
    encodeVideoSegment({
      bytes,
      file,
      fileHash,
      totalChunks,
      totalSegments,
      maxDataChunksPerVideo,
      segmentIndex,
      repeatFrames,
      onProgress: segmentProgress
    });
  const videos =
    totalSegments <= 1
      ? [await encodeSegment(0, onProgress)]
      : await encodeSegmentsInParallel(segmentIndexes, Math.min(SEGMENT_ENCODE_CONCURRENCY, totalSegments), encodeSegment, onProgress);

  onProgress?.({ phase: "MP4 set ready", completed: videos.length, total: videos.length });
  return videos;
}

async function encodeVideoSegment({
  bytes,
  file,
  fileHash,
  totalChunks,
  totalSegments,
  maxDataChunksPerVideo,
  segmentIndex,
  repeatFrames,
  onProgress
}: EncodeSegmentInput): Promise<EncodedVideo> {
  const chunkStart = segmentIndex * maxDataChunksPerVideo;
  const chunkEnd = Math.min(totalChunks, chunkStart + maxDataChunksPerVideo);
  const dataChunkCount = chunkEnd - chunkStart;
  const parityChunks = Math.ceil(dataChunkCount / VIDEO_PARITY_GROUP_SIZE);
  const totalCanvasWork = dataChunkCount + parityChunks;
  const dataPayloads: Uint8Array[] = [];
  const renderJobs: RenderChunkJob[] = [];
  const segmentLabel = totalSegments > 1 ? ` ${segmentIndex + 1}/${totalSegments}` : "";
  let preparedChunks = 0;

  onProgress?.({ phase: `Preparing chunks${segmentLabel}`, completed: 0, total: totalCanvasWork });
  for (let chunkIndex = chunkStart; chunkIndex < chunkEnd; chunkIndex++) {
    const start = chunkIndex * PAYLOAD_BYTES_PER_IMAGE;
    const payload = bytes.slice(start, start + PAYLOAD_BYTES_PER_IMAGE);
    dataPayloads.push(payload);
    renderJobs.push({
      order: renderJobs.length,
      header: {
        kind: "data",
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
        fileSize: bytes.length,
        fileHash,
        chunkIndex,
        totalChunks,
        payloadLength: payload.length,
        chunkCrc: crc32(payload)
      },
      payload
    });
    preparedChunks++;
    onProgress?.({ phase: `Preparing chunks${segmentLabel}`, completed: preparedChunks, total: totalCanvasWork });
    await yieldToBrowser();
  }

  let parityIndex = Math.floor(chunkStart / VIDEO_PARITY_GROUP_SIZE);
  for (let groupStart = 0; groupStart < dataPayloads.length; groupStart += VIDEO_PARITY_GROUP_SIZE) {
    const group = dataPayloads.slice(groupStart, groupStart + VIDEO_PARITY_GROUP_SIZE);
    const parityPayload = xorPayloads(group);
    const parityStartIndex = chunkStart + groupStart;
    renderJobs.push({
      order: renderJobs.length,
      header: {
        kind: "xor",
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
        fileSize: bytes.length,
        fileHash,
        chunkIndex: totalChunks + parityIndex,
        totalChunks,
        payloadLength: parityPayload.length,
        chunkCrc: crc32(parityPayload),
        parityStartIndex,
        parityMemberCount: group.length,
        parityLastMemberLength: group.at(-1)?.length
      },
      payload: parityPayload
    });
    parityIndex++;
    preparedChunks++;
    onProgress?.({ phase: `Preparing chunks${segmentLabel}`, completed: preparedChunks, total: totalCanvasWork });
    await yieldToBrowser();
  }

  const blob = await recordChunkJobsAsMp4(renderJobs, repeatFrames, VIDEO_FPS, (progress) =>
    onProgress?.({
      ...progress,
      phase: totalSegments > 1 ? `${progress.phase} ${segmentIndex + 1}/${totalSegments}` : progress.phase
    })
  );
  const durationSeconds = (renderJobs.length * repeatFrames) / VIDEO_FPS;
  const payloadBytes =
    chunkStart * PAYLOAD_BYTES_PER_IMAGE >= bytes.length
      ? 0
      : bytes.slice(chunkStart * PAYLOAD_BYTES_PER_IMAGE, Math.min(bytes.length, chunkEnd * PAYLOAD_BYTES_PER_IMAGE)).length;
  return {
    blob,
    url: URL.createObjectURL(blob),
    frameCount: renderJobs.length * repeatFrames,
    chunkCount: renderJobs.length,
    payloadBytes,
    fileBytes: bytes.length,
    durationSeconds,
    segmentIndex,
    totalSegments,
    dataChunkStart: chunkStart,
    dataChunkEnd: chunkEnd - 1,
    dataChunkCount,
    audioPacketCount: 0,
    audioPayloadBytes: 0,
    caption: [
      "FLIPTABLE IGDB VIDEO v1",
      `file=${file.name}`,
      `segment=${segmentIndex + 1}/${totalSegments}`,
      `dataChunks=${chunkStart + 1}-${chunkEnd}/${totalChunks}`,
      `chunks=${renderJobs.length}`,
      `fps=${VIDEO_FPS}`,
      `repeat=${repeatFrames}`,
      `parity=xor-${VIDEO_PARITY_GROUP_SIZE}+1`,
      `codec=colorgrid${palette.length}-h264-mp4`,
      `size=${bytes.length}`,
      `sha256=${fileHash}`
    ].join("\n")
  };
}

function planHybridSegments(fileSize: number, maxVisualChunksPerVideo: number): HybridSegmentPlan[] {
  const segments: HybridSegmentPlan[] = [];
  let offset = 0;
  let chunkIndex = 0;
  const maxVisualBytesPerVideo = maxVisualChunksPerVideo * PAYLOAD_BYTES_PER_IMAGE;
  while (offset < fileSize) {
    const segmentStart = offset;
    const visualEnd = Math.min(fileSize, segmentStart + maxVisualBytesPerVideo);
    const visualChunks: HybridSegmentPlan["visualChunks"] = [];
    while (offset < visualEnd) {
      const payloadLength = Math.min(PAYLOAD_BYTES_PER_IMAGE, visualEnd - offset);
      visualChunks.push({ chunkIndex, payloadStart: offset, payloadLength });
      offset += payloadLength;
      chunkIndex++;
    }

    const visualDurationSeconds = transmittedFrameCountForDataChunks(visualChunks.length) * (VIDEO_REPEAT_FRAMES / VIDEO_FPS);
    const audioBytesForSegment = Math.min(
      visualEnd - segmentStart,
      audioProbeByteCapacityForDuration(visualDurationSeconds, AUDIO_PAYLOAD_BYTES)
    );
    const audioChunks: HybridSegmentPlan["audioChunks"] = [];
    for (let audioOffset = segmentStart; audioOffset < segmentStart + audioBytesForSegment;) {
      const payloadLength = Math.min(AUDIO_PROBE_PAYLOAD_BYTES, segmentStart + audioBytesForSegment - audioOffset);
      audioChunks.push({ chunkIndex: visualChunks[0]?.chunkIndex ?? 0, payloadStart: audioOffset, payloadLength });
      audioOffset += payloadLength;
    }

    segments.push({ segmentIndex: segments.length, visualChunks, audioChunks });
  }
  return segments;
}

function transmittedFrameCountForDataChunks(dataChunkCount: number) {
  if (dataChunkCount <= 0) return 0;
  return dataChunkCount + Math.ceil(dataChunkCount / VIDEO_PARITY_GROUP_SIZE);
}

async function encodeHybridVideoSegment({
  bytes,
  file,
  fileHash,
  totalChunks,
  totalSegments,
  segment,
  repeatFrames,
  onProgress
}: EncodeHybridSegmentInput): Promise<EncodedVideo> {
  const dataChunkCount = segment.visualChunks.length;
  const parityChunks = Math.ceil(dataChunkCount / VIDEO_PARITY_GROUP_SIZE);
  const totalCanvasWork = dataChunkCount + parityChunks;
  const dataPayloads: Uint8Array[] = [];
  const renderJobs: RenderChunkJob[] = [];
  const segmentLabel = totalSegments > 1 ? ` ${segment.segmentIndex + 1}/${totalSegments}` : "";
  let preparedChunks = 0;

  onProgress?.({ phase: `Preparing chunks${segmentLabel}`, completed: 0, total: totalCanvasWork });
  for (const chunk of segment.visualChunks) {
    const payload = bytes.slice(chunk.payloadStart, chunk.payloadStart + chunk.payloadLength);
    dataPayloads.push(payload);
    renderJobs.push({
      order: renderJobs.length,
      header: {
        kind: "data",
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
        fileSize: bytes.length,
        fileHash,
        chunkIndex: chunk.chunkIndex,
        totalChunks,
        payloadLength: payload.length,
        chunkCrc: crc32(payload)
      },
      payload
    });
    preparedChunks++;
    onProgress?.({ phase: `Preparing chunks${segmentLabel}`, completed: preparedChunks, total: totalCanvasWork });
    await yieldToBrowser();
  }

  let parityIndex = Math.floor((segment.visualChunks[0]?.chunkIndex ?? 0) / VIDEO_PARITY_GROUP_SIZE);
  for (let groupStart = 0; groupStart < dataPayloads.length; groupStart += VIDEO_PARITY_GROUP_SIZE) {
    const group = dataPayloads.slice(groupStart, groupStart + VIDEO_PARITY_GROUP_SIZE);
    const parityPayload = xorPayloads(group);
    const parityStartIndex = segment.visualChunks[groupStart].chunkIndex;
    renderJobs.push({
      order: renderJobs.length,
      header: {
        kind: "xor",
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
        fileSize: bytes.length,
        fileHash,
        chunkIndex: totalChunks + parityIndex,
        totalChunks,
        payloadLength: parityPayload.length,
        chunkCrc: crc32(parityPayload),
        parityStartIndex,
        parityMemberCount: group.length,
        parityLastMemberLength: group.at(-1)?.length
      },
      payload: parityPayload
    });
    parityIndex++;
    preparedChunks++;
    onProgress?.({ phase: `Preparing chunks${segmentLabel}`, completed: preparedChunks, total: totalCanvasWork });
    await yieldToBrowser();
  }

  const audioPayloads = segment.audioChunks.map((chunk) => bytes.slice(chunk.payloadStart, chunk.payloadStart + chunk.payloadLength));
  const blob = await recordChunkJobsAsMp4(
    renderJobs,
    repeatFrames,
    VIDEO_FPS,
    (progress) =>
      onProgress?.({
        ...progress,
        phase: totalSegments > 1 ? `${progress.phase} ${segment.segmentIndex + 1}/${totalSegments}` : progress.phase
      }),
    audioPayloads
  );
  const durationSeconds = Math.max(
    (renderJobs.length * repeatFrames) / VIDEO_FPS,
    audioPayloads.reduce((sum, payload) => sum + audioProbeDurationForByteLength(payload.length), 0),
    INSTAGRAM_MIN_VIDEO_SECONDS
  );
  const visualPayloadBytes = segment.visualChunks.reduce((sum, chunk) => sum + chunk.payloadLength, 0);
  const audioPayloadBytes = segment.audioChunks.reduce((sum, chunk) => sum + chunk.payloadLength, 0);
  const firstVisualChunk = segment.visualChunks[0];
  const lastVisualChunk = segment.visualChunks.at(-1);
  const firstAudioChunk = segment.audioChunks[0];
  return {
    blob,
    audioPayload: audioPayloadBytes > 0
      ? new Blob(audioPayloads, { type: "application/octet-stream" })
      : undefined,
    url: URL.createObjectURL(blob),
    frameCount: renderJobs.length * repeatFrames,
    chunkCount: renderJobs.length,
    payloadBytes: visualPayloadBytes,
    fileBytes: bytes.length,
    durationSeconds,
    segmentIndex: segment.segmentIndex,
    totalSegments,
    dataChunkStart: firstVisualChunk?.chunkIndex ?? firstAudioChunk?.chunkIndex ?? 0,
    dataChunkEnd: lastVisualChunk?.chunkIndex ?? 0,
    dataChunkCount,
    audioPacketCount: segment.audioChunks.length,
    audioPayloadBytes,
    caption: [
      "FLIPTABLE IGDB VIDEO v1",
      `file=${file.name}`,
      `segment=${segment.segmentIndex + 1}/${totalSegments}`,
      `visualChunks=${firstVisualChunk ? `${firstVisualChunk.chunkIndex + 1}-${(lastVisualChunk?.chunkIndex ?? firstVisualChunk.chunkIndex) + 1}` : "none"}/${totalChunks}`,
      `audioCopy=${firstAudioChunk ? `${segment.audioChunks.length} packets ${audioPayloadBytes} bytes` : "none"}`,
      `chunks=${renderJobs.length}`,
      `fps=${VIDEO_FPS}`,
      `repeat=${repeatFrames}`,
      `parity=xor-${VIDEO_PARITY_GROUP_SIZE}+1`,
      `codec=colorgrid${palette.length}-h264-mp4+dtmf16-aac`,
      `durationTarget=${VIDEO_TARGET_SECONDS}`,
      `size=${bytes.length}`,
      `sha256=${fileHash}`
    ].join("\n")
  };
}

async function encodeSegmentsInParallel(
  segmentIndexes: number[],
  concurrency: number,
  encodeSegment: (segmentIndex: number, onProgress?: (progress: EncodeVideoProgress) => void) => Promise<EncodedVideo>,
  onProgress?: (progress: EncodeVideoProgress) => void
) {
  const progressBySegment = segmentIndexes.map<EncodeVideoProgress>(() => ({ phase: "Queued", completed: 0, total: 1 }));
  const videos = new Array<EncodedVideo>(segmentIndexes.length);
  const totalProgressUnits = segmentIndexes.length * 1000;
  const publishProgress = () => {
    const completed = Math.round(
      progressBySegment.reduce((sum, progress) => {
        const total = Math.max(progress.total, 1);
        return sum + Math.max(0, Math.min(1, progress.completed / total)) * 1000;
      }, 0)
    );
    const activeCount = progressBySegment.filter(
      (progress) => progress.phase !== "Queued" && progress.completed < progress.total
    ).length;
    onProgress?.({
      phase: activeCount
        ? `Encoding ${segmentIndexes.length} MP4s (${Math.min(activeCount, concurrency)} active)`
        : `Encoding ${segmentIndexes.length} MP4s`,
      completed,
      total: totalProgressUnits
    });
  };

  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, concurrency) }, async () => {
      while (nextIndex < segmentIndexes.length) {
        const arrayIndex = nextIndex++;
        const segmentIndex = segmentIndexes[arrayIndex];
        progressBySegment[arrayIndex] = { phase: "Starting", completed: 0, total: 1 };
        publishProgress();
        videos[arrayIndex] = await encodeSegment(segmentIndex, (progress) => {
          progressBySegment[arrayIndex] = progress;
          publishProgress();
        });
        progressBySegment[arrayIndex] = { phase: "Complete", completed: 1, total: 1 };
        publishProgress();
      }
    })
  );

  return videos.sort((left, right) => left.segmentIndex - right.segmentIndex);
}

export async function decodeVideoFile(
  file: File,
  onProgress?: (progress: DecodeVideoProgress) => void
): Promise<DecodeResult[]> {
  return decodeHybridVideoFile(file, onProgress);
}

async function decodeHybridVideoFile(
  file: File,
  onProgress?: (progress: DecodeVideoProgress) => void
): Promise<DecodeResult[]> {
  const visualChunks = await decodeVideoFileTemporalVote(file, VIDEO_REPEAT_FRAMES, onProgress);
  const template = visualChunks.find((chunk) => chunk.ok && chunk.kind === "data");
  if (!template) return visualChunks;

  const fullVisualChunkCount = Math.ceil(template.fileSize / PAYLOAD_BYTES_PER_IMAGE);
  if (template.totalChunks === fullVisualChunkCount) return visualChunks;

  const maxChunkIndex = Math.max(...visualChunks.filter((chunk) => chunk.kind === "data").map((chunk) => chunk.chunkIndex));
  const audioStartChunkIndex = maxChunkIndex + 1;
  const audioChunkCount = Math.min(AUDIO_PACKETS_PER_VIDEO, Math.max(0, template.totalChunks - audioStartChunkIndex));
  if (!audioChunkCount || visualChunks.some((chunk) => chunk.chunkIndex === audioStartChunkIndex)) {
    return visualChunks;
  }

  try {
    const visualPayloadBytes = visualChunks
      .filter((chunk) => chunk.ok && chunk.kind === "data" && chunk.chunkIndex < audioStartChunkIndex)
      .sort((left, right) => left.chunkIndex - right.chunkIndex)
      .reduce((sum, chunk) => sum + chunk.payload.length, 0);
    const audioByteLength = Math.min(AUDIO_PROBE_PAYLOAD_BYTES, Math.max(0, template.fileSize - visualPayloadBytes));
    if (!audioByteLength) return visualChunks;

    const audioPackets = await decodeDtmfProbeBytePacketsFromFile(file, audioChunkCount, audioByteLength);
    const audioChunks = audioPackets.flatMap((audio, index): DecodeResult[] => {
      if (!audio.ok) return [];
      return [{
        ok: true,
        kind: "data",
        fileName: template.fileName,
        mimeType: template.mimeType,
        fileSize: template.fileSize,
        fileHash: template.fileHash,
        chunkIndex: audioStartChunkIndex + index,
        totalChunks: template.totalChunks,
        payload: audio.bytes,
        message: `decoded from audio side channel packet ${index + 1}/${audioChunkCount} (${Math.round(audio.confidence * 100)}% sync)`
      }];
    });
    return recoverDataChunks([...visualChunks, ...audioChunks]);
  } catch {
    return visualChunks;
  }
}

async function decodeVideoFileSingleFrame(
  file: File,
  onProgress?: (progress: DecodeVideoProgress) => void
): Promise<DecodeResult[]> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  const url = URL.createObjectURL(file);
  video.src = url;
  onProgress?.({ phase: "Loading video", completed: 0, total: 1 });

  try {
    await waitForVideoMetadata(video);
    onProgress?.({ phase: "Sampling frames", completed: 0, total: 1 });
    const canvas = document.createElement("canvas");
    canvas.width = CANVAS_SIZE;
    canvas.height = CANVAS_SIZE;
    const ctx = requiredContext(canvas);
    const byChunk = new Map<number, DecodeResult>();
    const decodePool = createDecodeWorkerPool();
    const pendingDecodes: Promise<void>[] = [];
    let queuedFrames = 0;
    let decodedFrames = 0;
    let samplingComplete = false;
    video.playbackRate = 0.25;

    try {
      await sampleVideoFrames(
        video,
        async () => {
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
          ctx.drawImage(video, 0, 0, CANVAS_SIZE, CANVAS_SIZE);
          const imageData = ctx.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE).data;
          queuedFrames++;
          if (!decodePool) {
            try {
              const decoded = await decodeFrameData(imageData, decodePool);
              if (decoded.ok && !byChunk.has(decoded.chunkIndex)) {
                byChunk.set(decoded.chunkIndex, decoded);
              }
            } catch {
              // Video compression can make individual frames undecodable; repeated frames handle this.
            } finally {
              decodedFrames++;
            }
            return;
          }

          const decodePromise = decodeFrameData(imageData, decodePool)
            .then((decoded) => {
              if (decoded.ok && !byChunk.has(decoded.chunkIndex)) {
                byChunk.set(decoded.chunkIndex, decoded);
              }
            })
            .catch(() => {
              // Video compression can make individual frames undecodable; repeated frames handle this.
            })
            .finally(() => {
              decodedFrames++;
              if (samplingComplete) {
                onProgress?.({ phase: "Decoding frames", completed: decodedFrames, total: queuedFrames });
              }
            });
          pendingDecodes.push(decodePromise);
          if (decodePool.pendingCount >= DECODE_WORKER_BACKLOG) {
            await decodePool.waitForAvailable();
          }
        },
        onProgress
      );

      samplingComplete = true;
      onProgress?.({ phase: "Decoding frames", completed: decodedFrames, total: queuedFrames || 1 });
      await Promise.all(pendingDecodes);
      onProgress?.({ phase: "Recovering chunks", completed: 1, total: 1 });
      return recoverDataChunks([...byChunk.values()]);
    } finally {
      decodePool?.terminate();
    }
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function decodeVideoFileTemporalVote(
  file: File,
  repeatFrames = VIDEO_REPEAT_FRAMES,
  onProgress?: (progress: DecodeVideoProgress) => void
): Promise<DecodeResult[]> {
  onProgress?.({ phase: "Loading video", completed: 0, total: 1 });
  const { Input, ALL_FORMATS, BlobSource, CanvasSink } = await import("mediabunny");
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });

  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error("Could not find a video track for decoding.");
    const stats = await track.computePacketStats();
    const totalFrames = Math.max(1, stats.packetCount);
    const sink = new CanvasSink(track, { width: CANVAS_SIZE, height: CANVAS_SIZE, fit: "fill" });
    const canvas = document.createElement("canvas");
    canvas.width = CANVAS_SIZE;
    canvas.height = CANVAS_SIZE;
    const ctx = requiredContext(canvas);
    const sampledFrames: number[][] = [];
    const byChunk = new Map<number, DecodeResult>();
    let frameIndex = 0;

    for await (const frame of sink.canvases()) {
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
      ctx.drawImage(frame.canvas, 0, 0, CANVAS_SIZE, CANVAS_SIZE);
      const imageData = ctx.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE).data;
      const symbols = readSymbolsFromImageData(imageData);
      sampledFrames.push(symbols);
      try {
        const decoded = decodeSymbols(symbols);
        if (decoded.ok && !byChunk.has(decoded.chunkIndex)) {
          byChunk.set(decoded.chunkIndex, decoded);
        }
      } catch {
        // Temporal voting below recovers frames damaged at video transitions.
      }
      frameIndex++;
      onProgress?.({ phase: "Sampling repeated frames", completed: frameIndex, total: totalFrames });
      if (frameIndex % 8 === 7) await yieldToBrowser();
    }

    const windowCount = Math.max(1, sampledFrames.length - repeatFrames + 1);
    let decodedGroups = 0;
    for (let start = 0; start < windowCount; start++) {
      try {
        const decoded = decodeSymbols(majoritySymbols(sampledFrames.slice(start, start + repeatFrames)));
        if (decoded.ok && !byChunk.has(decoded.chunkIndex)) {
          byChunk.set(decoded.chunkIndex, decoded);
        }
      } catch {
        // Compression damage can still make a whole repeated group undecodable.
      }
      decodedGroups++;
      onProgress?.({ phase: "Sliding temporal decoding", completed: decodedGroups, total: windowCount });
      if (decodedGroups % 8 === 0) await yieldToBrowser();
    }

    onProgress?.({ phase: "Recovering chunks", completed: 1, total: 1 });
    return recoverDataChunks([...byChunk.values()]);
  } finally {
    input.dispose();
  }
}

export function encodeIndexPost(files: FileManifest[]): { canvas: HTMLCanvasElement; manifestFile: File } {
  const body = {
    protocol: "fliptable-igdb-index",
    version: 1,
    updatedAt: new Date().toISOString(),
    files
  };
  const indexBytes = encoder.encode(JSON.stringify(body, null, 2));
  const file = new File([indexBytes], "igdb-index.json", { type: "application/json" });
  return {
    canvas: encodeChunk(
      {
        kind: "data",
        fileName: file.name,
        mimeType: file.type,
        fileSize: indexBytes.length,
        fileHash: "",
        chunkIndex: 0,
        totalChunks: 1,
        payloadLength: indexBytes.length,
        chunkCrc: crc32(indexBytes)
      },
      indexBytes
    ),
    manifestFile: file
  };
}

export async function decodeImage(file: File): Promise<DecodeResult> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = CANVAS_SIZE;
  canvas.height = CANVAS_SIZE;
  const ctx = requiredContext(canvas);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(bitmap, 0, 0, CANVAS_SIZE, CANVAS_SIZE);
  bitmap.close();

  const imageData = ctx.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE).data;
  return decodeImageData(imageData);
}

export function decodeCanvas(canvas: HTMLCanvasElement): DecodeResult {
  const normalized = document.createElement("canvas");
  normalized.width = CANVAS_SIZE;
  normalized.height = CANVAS_SIZE;
  const ctx = requiredContext(normalized);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(canvas, 0, 0, CANVAS_SIZE, CANVAS_SIZE);
  return decodeImageData(ctx.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE).data);
}

function decodeImageData(imageData: Uint8ClampedArray): DecodeResult {
  return decodeSymbols(readSymbolsFromImageData(imageData));
}

function readSymbolsFromImageData(imageData: Uint8ClampedArray) {
  const symbols: number[] = [];
  const swatches = readCalibrationSwatches(imageData);
  for (let row = 0; row < GRID_CELLS; row++) {
    for (let col = 0; col < GRID_CELLS; col++) {
      symbols.push(nearestPaletteIndex(sampleCellAverage(imageData, col, row), swatches));
    }
  }
  return symbols;
}

function decodeSymbols(symbols: number[]): DecodeResult {
  try {
    return decodeChunkBytes(bitsToBytes(symbols));
  } catch {
    return decodeChunkBytes(legacyBitsToBytes(symbols));
  }
}

function decodeChunkBytes(allBytes: Uint8Array): DecodeResult {
  if (!MAGIC.every((byte, index) => allBytes[index] === byte) || allBytes[4] !== VERSION) {
    throw new Error("Unknown video payload format.");
  }
  const headerLength = readUint16(allBytes, 5);
  if (headerLength <= 0 || headerLength > HEADER_BYTES - 7) throw new Error("Invalid video payload header.");
  const headerJson = decoder.decode(allBytes.slice(7, 7 + headerLength));
  const header = normalizeHeader(JSON.parse(headerJson) as Header | CompactHeader);
  const payloadStart = HEADER_BYTES;
  const payload = allBytes.slice(payloadStart, payloadStart + header.payloadLength);
  const crcOk = crc32(payload) === header.chunkCrc;
  const parityMembers = expandParityMembers(header);

  return {
    ok: crcOk,
    kind: header.kind ?? "data",
    fileName: header.fileName,
    mimeType: header.mimeType,
    fileSize: header.fileSize,
    fileHash: header.fileHash,
    chunkIndex: header.chunkIndex,
    totalChunks: header.totalChunks,
    payload,
    message: crcOk ? "decoded" : "decoded with checksum mismatch",
    parityMemberIndexes: parityMembers.indexes,
    parityMemberLengths: parityMembers.lengths
  };
}

function expandParityMembers(header: Header) {
  if (header.parityMemberIndexes?.length) {
    return { indexes: header.parityMemberIndexes, lengths: header.parityMemberLengths ?? [] };
  }
  const count = header.parityMemberCount ?? 0;
  const start = header.parityStartIndex ?? 0;
  const indexes = Array.from({ length: count }, (_, index) => start + index);
  const lengths = new Array<number>(count).fill(PAYLOAD_BYTES_PER_IMAGE);
  if (count && header.parityLastMemberLength !== undefined) lengths[count - 1] = header.parityLastMemberLength;
  return { indexes, lengths };
}

function majoritySymbols(groups: number[][]) {
  if (!groups.length) throw new Error("No repeated frames available for majority vote.");
  const symbols = new Array<number>(SYMBOL_COUNT).fill(0);
  for (let symbolIndex = 0; symbolIndex < SYMBOL_COUNT; symbolIndex++) {
    const counts = new Array<number>(SYMBOL_RADIX).fill(0);
    for (const group of groups) {
      counts[group[symbolIndex] ?? 0]++;
    }
    let bestSymbol = 0;
    let bestCount = -1;
    for (let symbol = 0; symbol < counts.length; symbol++) {
      if (counts[symbol] > bestCount) {
        bestSymbol = symbol;
        bestCount = counts[symbol];
      }
    }
    symbols[symbolIndex] = bestSymbol;
  }
  return symbols;
}

export async function reassemble(results: DecodeResult[]): Promise<{ blob: Blob; fileName: string; hashOk: boolean; hash: string }> {
  const chunks = recoverDataChunks(results);
  const totalSize = chunks[0]?.fileSize ?? 0;
  const out = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= out.length) break;
    const payload = chunk.payload.slice(0, out.length - offset);
    out.set(payload, offset);
    offset += payload.length;
  }
  const hash = await sha256Hex(out);
  const expectedHash = chunks[0]?.fileHash;
  return {
    blob: new Blob([out], { type: chunks[0]?.mimeType || "application/octet-stream" }),
    fileName: chunks[0]?.fileName || "download.bin",
    hashOk: !expectedHash || hash === expectedHash,
    hash
  };
}

export function recoverDataChunks(results: DecodeResult[]) {
  const dataByIndex = new Map<number, DecodeResult>();
  const parityChunks = results.filter((chunk) => chunk.ok && chunk.kind === "xor");
  for (const chunk of results) {
    if (chunk.ok && chunk.kind === "data") dataByIndex.set(chunk.chunkIndex, chunk);
  }

  let madeProgress = true;
  while (madeProgress) {
    madeProgress = false;
    for (const parity of parityChunks) {
      const indexes = parity.parityMemberIndexes ?? [];
      const lengths = parity.parityMemberLengths ?? [];
      const missing = indexes.filter((index) => !dataByIndex.has(index));
      if (missing.length !== 1) continue;

      const missingIndex = missing[0];
      const restored = parity.payload.slice();
      for (const index of indexes) {
        const known = dataByIndex.get(index);
        if (!known) continue;
        for (let i = 0; i < restored.length; i++) restored[i] ^= known.payload[i] ?? 0;
      }

      const memberOffset = indexes.indexOf(missingIndex);
      const payload = restored.slice(0, lengths[memberOffset] ?? PAYLOAD_BYTES_PER_IMAGE);
      dataByIndex.set(missingIndex, {
        ...parity,
        kind: "data",
        chunkIndex: missingIndex,
        payload,
        message: "recovered from xor parity",
        parityMemberIndexes: undefined,
        parityMemberLengths: undefined
      });
      madeProgress = true;
    }
  }

  return [...dataByIndex.values()].sort((a, b) => a.chunkIndex - b.chunkIndex);
}

export async function simulateInstagramRoundTrip(canvas: HTMLCanvasElement, quality: number): Promise<File> {
  const jpegBlob = await canvasToBlob(canvas, "image/jpeg", quality);
  const bitmap = await createImageBitmap(jpegBlob);
  const normalized = document.createElement("canvas");
  normalized.width = CANVAS_SIZE;
  normalized.height = CANVAS_SIZE;
  const ctx = requiredContext(normalized);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  ctx.drawImage(bitmap, 0, 0, CANVAS_SIZE, CANVAS_SIZE);
  bitmap.close();
  const finalBlob = await canvasToBlob(normalized, "image/jpeg", quality);
  return new File([finalBlob], "simulated-instagram.jpg", { type: "image/jpeg" });
}

export function downloadCanvas(canvas: HTMLCanvasElement, name: string) {
  canvas.toBlob((blob) => {
    if (!blob) return;
    downloadBlob(blob, name);
  }, "image/png");
}

export function downloadBlob(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 500);
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function captionForManifest(manifest: FileManifest, chunkIndex: number) {
  return [
    "FLIPTABLE IGDB v1",
    `file=${manifest.name}`,
    `chunk=${chunkIndex + 1}/${manifest.totalChunks}`,
    `codec=colorgrid${palette.length}`,
    `size=${manifest.size}`,
    `sha256=${manifest.sha256}`
  ].join("\n");
}

function xorPayloads(payloads: Uint8Array[]) {
  const out = new Uint8Array(PAYLOAD_BYTES_PER_IMAGE);
  for (const payload of payloads) {
    for (let i = 0; i < payload.length; i++) out[i] ^= payload[i];
  }
  return out;
}

function padAudioPayload(payload: Uint8Array) {
  const out = new Uint8Array(AUDIO_PROBE_PAYLOAD_BYTES);
  out.set(payload.slice(0, AUDIO_PROBE_PAYLOAD_BYTES));
  return out;
}

function maxDataChunksForTargetVideo(repeatFrames: number, targetSeconds = VIDEO_TARGET_SECONDS) {
  const maxTransmittedChunks = Math.floor((targetSeconds * VIDEO_FPS) / repeatFrames);
  let dataChunks = 0;
  while (dataChunks + 1 + Math.ceil((dataChunks + 1) / VIDEO_PARITY_GROUP_SIZE) <= maxTransmittedChunks) {
    dataChunks++;
  }
  return Math.max(1, dataChunks);
}

async function renderChunkFrames(
  jobs: RenderChunkJob[],
  phase: string,
  onProgress?: (progress: EncodeVideoProgress) => void
): Promise<FrameSource[]> {
  onProgress?.({ phase, completed: 0, total: jobs.length });
  if (canUseEncodeWorkers(jobs.length)) {
    try {
      return await renderChunkFramesInWorkers(jobs, phase, onProgress);
    } catch {
      // Fall back to main-thread rendering if the browser cannot run OffscreenCanvas workers.
    }
  }

	  const frames: FrameSource[] = [];
	  let completed = 0;
	  for (const job of jobs) {
	    frames[job.order] = encodeChunk(job.header, job.payload);
	    completed++;
	    onProgress?.({ phase, completed, total: jobs.length });
	    await yieldToBrowser();
	  }
  return frames;
}

function canUseEncodeWorkers(jobCount: number) {
  return (
    jobCount >= 8 &&
    ENABLE_ENCODE_WORKERS &&
    typeof Worker !== "undefined" &&
    typeof OffscreenCanvas !== "undefined" &&
    typeof ImageBitmap !== "undefined"
  );
}

function renderChunkFramesInWorkers(
  jobs: RenderChunkJob[],
  phase: string,
  onProgress?: (progress: EncodeVideoProgress) => void
) {
  return new Promise<FrameSource[]>((resolve, reject) => {
    const workerCount = Math.min(ENCODE_WORKER_COUNT, jobs.length);
    const workers = Array.from({ length: workerCount }, () => new Worker(new URL("./codec-worker.ts", import.meta.url), { type: "module" }));
    const frames: FrameSource[] = new Array(jobs.length);
    let nextJob = 0;
    let completed = 0;
    let settled = false;

    const cleanup = () => workers.forEach((worker) => worker.terminate());
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const assign = (worker: Worker) => {
      if (settled) return;
      const job = jobs[nextJob++];
      if (!job) {
        if (completed === jobs.length) {
          settled = true;
          cleanup();
          resolve(frames);
        }
        return;
      }

      const payload = job.payload.buffer.slice(job.payload.byteOffset, job.payload.byteOffset + job.payload.byteLength);
      worker.postMessage(
        {
          id: job.order,
          header: job.header,
          profile: workerCodecProfile(),
          payload
        },
        [payload]
      );
    };

    for (const worker of workers) {
      worker.onmessage = (event: MessageEvent<{ id: number; bitmap: ImageBitmap; error?: string }>) => {
        if (event.data.error) {
          fail(new Error(event.data.error));
          return;
        }

        frames[event.data.id] = event.data.bitmap;
        completed++;
        onProgress?.({ phase, completed, total: jobs.length });
        assign(worker);
      };
      worker.onerror = (event) => fail(event.error ?? new Error(event.message));
      assign(worker);
    }
  });
}

function workerCodecProfile(): WorkerCodecProfile {
  return {
    canvasSize: CANVAS_SIZE,
    cellSize: CELL_SIZE,
    gridOrigin: GRID_ORIGIN,
    gridCells: GRID_CELLS,
    palette: palette.map((color) => [...color]),
    headerBytes: HEADER_BYTES,
    rawChunkBytes: RAW_CHUNK_BYTES,
    symbolCount: SYMBOL_COUNT,
    symbolRadix: SYMBOL_RADIX
  };
}

function encodeChunk(header: Header, payload: Uint8Array): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = CANVAS_SIZE;
  canvas.height = CANVAS_SIZE;
  const ctx = requiredContext(canvas);
  drawEncodedChunk(ctx, header, payload);
  return canvas;
}

function drawEncodedChunk(ctx: CanvasRenderingContext2D, header: Header, payload: Uint8Array) {
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  drawFrame(ctx);

  const packed = packChunk(header, payload);
  const symbols = bytesToSymbols(packed);
  drawSymbolGrid(ctx, symbols);

  drawCalibration(ctx);
}

let symbolGridCanvas: HTMLCanvasElement | null = null;

function drawSymbolGrid(ctx: CanvasRenderingContext2D, symbols: number[]) {
  if (!symbolGridCanvas) {
    symbolGridCanvas = document.createElement("canvas");
    symbolGridCanvas.width = GRID_CELLS;
    symbolGridCanvas.height = GRID_CELLS;
  }
  const gridContext = requiredContext(symbolGridCanvas);
  const image = gridContext.createImageData(GRID_CELLS, GRID_CELLS);
  for (let index = 0; index < symbols.length; index++) {
    const [r, g, b] = palette[symbols[index] ?? 0];
    const pixel = index * 4;
    image.data[pixel] = r;
    image.data[pixel + 1] = g;
    image.data[pixel + 2] = b;
    image.data[pixel + 3] = 255;
  }
  gridContext.putImageData(image, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(
    symbolGridCanvas,
    GRID_ORIGIN,
    GRID_ORIGIN,
    GRID_CELLS * CELL_SIZE,
    GRID_CELLS * CELL_SIZE
  );
}

async function recordCanvasesAsMp4(
  frames: FrameSource[],
  repeatFrames: number,
  fps: number,
  onProgress?: (progress: EncodeVideoProgress) => void
) {
  if (!frames.length) {
    throw new Error("No chunks to record.");
  }

  const { BufferTarget, CanvasSource, Mp4OutputFormat, Output } = await import("mediabunny");
  const format = new Mp4OutputFormat({ fastStart: "in-memory" });
  const videoEncoder = await pickInstagramVideoEncoder(format);
  if (!videoEncoder) {
    throw new Error("This browser cannot encode H.264 MP4 video. Try Safari or a current Chromium browser.");
  }

  const stage = document.createElement("canvas");
  stage.width = CANVAS_SIZE;
  stage.height = CANVAS_SIZE;
  const ctx = requiredContext(stage);
  const target = new BufferTarget();
  const output = new Output({
    format,
    target
  });
  const source = new CanvasSource(stage, {
    codec: videoEncoder.codec,
    bitrate: VIDEO_BITRATE,
    bitrateMode: videoEncoder.bitrateMode,
    latencyMode: "realtime"
  });
  output.addVideoTrack(source, {
    frameRate: fps
  });

  await output.start();
  const frameDuration = 1 / fps;
  let frameIndex = 0;
  const totalFrames = frames.length * repeatFrames;
  onProgress?.({ phase: "Encoding MP4", completed: 0, total: totalFrames });
  for (const frame of frames) {
    for (let repeatIndex = 0; repeatIndex < repeatFrames; repeatIndex++) {
      ctx.drawImage(frame, 0, 0, CANVAS_SIZE, CANVAS_SIZE);
      await source.add(frameIndex * frameDuration, frameDuration, { keyFrame: repeatIndex === 0 });
      frameIndex++;
      onProgress?.({ phase: "Encoding MP4", completed: frameIndex, total: totalFrames });
    }
  }
  source.close();
  onProgress?.({ phase: "Finalizing MP4", completed: totalFrames, total: totalFrames });
  await output.finalize();

  if (!target.buffer) {
    throw new Error("MP4 encoder did not produce a file.");
  }
  return new Blob([target.buffer], { type: "video/mp4" });
}

async function recordChunkJobsAsMp4(
  jobs: RenderChunkJob[],
  repeatFrames: number,
  fps: number,
  onProgress?: (progress: EncodeVideoProgress) => void,
  audioPayloads: Uint8Array[] = []
) {
  if (!jobs.length) {
    throw new Error("No chunks to record.");
  }

  const { BufferTarget, CanvasSource, Mp4OutputFormat, Output } = await import("mediabunny");
  const format = new Mp4OutputFormat({ fastStart: "in-memory" });
  const videoEncoder = await pickInstagramVideoEncoder(format);
  if (!videoEncoder) {
    throw new Error("This browser cannot encode H.264 MP4 video. Try Safari or a current Chromium browser.");
  }

  const stage = document.createElement("canvas");
  stage.width = CANVAS_SIZE;
  stage.height = CANVAS_SIZE;
  const ctx = requiredContext(stage);
  const target = new BufferTarget();
  const output = new Output({
    format,
    target
  });
  const source = new CanvasSource(stage, {
    codec: videoEncoder.codec,
    bitrate: VIDEO_BITRATE,
    bitrateMode: videoEncoder.bitrateMode,
    latencyMode: "realtime"
  });
  output.addVideoTrack(source, {
    frameRate: fps
  });
  await output.start();
  const chunkDuration = repeatFrames / fps;
  const audioDurationSeconds = audioPayloads.reduce(
    (sum, payload) => sum + audioProbeDurationForByteLength(payload.length),
    0
  );
  const visualFrames = jobs.length * repeatFrames;
  const visualDurationSeconds = visualFrames / fps;
  const targetDurationSeconds = Math.max(visualDurationSeconds, audioDurationSeconds, INSTAGRAM_MIN_VIDEO_SECONDS);
  const totalAdds = jobs.length + (targetDurationSeconds > visualDurationSeconds ? 1 : 0);
  let completedAdds = 0;
  let currentTime = 0;
  onProgress?.({ phase: "Encoding MP4 chunks", completed: 0, total: totalAdds });
  for (const job of jobs) {
    drawEncodedChunk(ctx, job.header, job.payload);
    await source.add(currentTime, chunkDuration, { keyFrame: true });
    currentTime += chunkDuration;
    completedAdds++;
    onProgress?.({ phase: "Encoding MP4 chunks", completed: completedAdds, total: totalAdds });
    await yieldToBrowser();
  }
  if (targetDurationSeconds > currentTime) {
    await source.add(currentTime, targetDurationSeconds - currentTime, { keyFrame: true });
    currentTime = targetDurationSeconds;
    completedAdds++;
    onProgress?.({ phase: "Encoding MP4 chunks", completed: completedAdds, total: totalAdds });
  }
  source.close();
  onProgress?.({ phase: "Finalizing MP4", completed: totalAdds, total: totalAdds });
  await output.finalize();

  if (!target.buffer) {
    throw new Error("MP4 encoder did not produce a file.");
  }
  return new Blob([target.buffer], { type: "video/mp4" });
}

function closeFrameSource(frame: FrameSource) {
  if (typeof ImageBitmap !== "undefined" && frame instanceof ImageBitmap) {
    frame.close();
  }
}

function createDecodeWorkerPool() {
  if (typeof Worker === "undefined") return null;
  try {
    return new DecodeWorkerPool(Math.min(DECODE_WORKER_COUNT, Math.max(1, (navigator.hardwareConcurrency || 2) - 1)));
  } catch {
    return null;
  }
}

async function decodeFrameData(imageData: Uint8ClampedArray, pool: DecodeWorkerPool | null) {
  if (!pool) return decodeImageData(imageData);
  const buffer = imageData.buffer;
  if (!(buffer instanceof ArrayBuffer)) return decodeImageData(imageData);
  const result = await pool.decode(buffer);
  return deserializeDecodeResult(result);
}

class DecodeWorkerPool {
  private workers: Worker[] = [];
  private idleWorkers: Worker[] = [];
  private queue: Array<{
    id: number;
    buffer: ArrayBuffer;
    resolve: (result: SerializedDecodeResult) => void;
    reject: (error: unknown) => void;
  }> = [];
  private activeJobs = new Map<number, { resolve: (result: SerializedDecodeResult) => void; reject: (error: unknown) => void }>();
  private activeWorkerJobs = new Map<Worker, number>();
  private availabilityWaiters: Array<() => void> = [];
  private nextId = 1;

  constructor(workerCount: number) {
    this.workers = Array.from(
      { length: workerCount },
      () => new Worker(new URL("./codec-decode-worker.ts", import.meta.url), { type: "module" })
    );
    this.idleWorkers = [...this.workers];
    for (const worker of this.workers) {
      worker.onmessage = (event: MessageEvent<DecodeWorkerResponse>) => this.handleMessage(worker, event.data);
      worker.onerror = (event) => this.handleWorkerError(worker, event.error ?? new Error(event.message));
    }
  }

  get pendingCount() {
    return this.queue.length + this.activeJobs.size;
  }

  decode(buffer: ArrayBuffer) {
    return new Promise<SerializedDecodeResult>((resolve, reject) => {
      this.queue.push({
        id: this.nextId++,
        buffer,
        resolve,
        reject
      });
      this.pump();
    });
  }

  waitForAvailable() {
    if (this.pendingCount < DECODE_WORKER_BACKLOG) return Promise.resolve();
    return new Promise<void>((resolve) => this.availabilityWaiters.push(resolve));
  }

  terminate() {
    for (const worker of this.workers) worker.terminate();
    this.workers = [];
    this.idleWorkers = [];
    this.queue = [];
    this.activeJobs.clear();
    this.activeWorkerJobs.clear();
    this.resolveAvailabilityWaiters();
  }

  private pump() {
    while (this.idleWorkers.length && this.queue.length) {
      const worker = this.idleWorkers.shift();
      const job = this.queue.shift();
      if (!worker || !job) return;
      this.activeJobs.set(job.id, { resolve: job.resolve, reject: job.reject });
      this.activeWorkerJobs.set(worker, job.id);
      worker.postMessage({ id: job.id, profile: workerCodecProfile(), imageData: job.buffer }, [job.buffer]);
    }
    this.resolveAvailabilityWaiters();
  }

  private handleMessage(worker: Worker, response: DecodeWorkerResponse) {
    const job = this.activeJobs.get(response.id);
    if (!job) return;
    this.activeJobs.delete(response.id);
    this.activeWorkerJobs.delete(worker);
    this.idleWorkers.push(worker);
    if (response.error || !response.result) {
      job.reject(new Error(response.error || "Decode worker returned no result."));
    } else {
      job.resolve(response.result);
    }
    this.pump();
  }

  private handleWorkerError(worker: Worker, error: unknown) {
    this.idleWorkers = this.idleWorkers.filter((candidate) => candidate !== worker);
    const jobId = this.activeWorkerJobs.get(worker);
    if (jobId) {
      const job = this.activeJobs.get(jobId);
      this.activeWorkerJobs.delete(worker);
      this.activeJobs.delete(jobId);
      job?.reject(error);
    } else {
      for (const [id, job] of this.activeJobs) {
        job.reject(error);
        this.activeJobs.delete(id);
        break;
      }
    }
    this.resolveAvailabilityWaiters();
  }

  private resolveAvailabilityWaiters() {
    if (this.pendingCount >= DECODE_WORKER_BACKLOG) return;
    const waiters = this.availabilityWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }
}

function deserializeDecodeResult(result: SerializedDecodeResult): DecodeResult {
  return {
    ...result,
    payload: new Uint8Array(result.payload)
  };
}

function yieldToBrowser() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

async function pickInstagramVideoEncoder(format: { getSupportedVideoCodecs: () => string[] }) {
  const { canEncodeVideo, getFirstEncodableVideoCodec } = await import("mediabunny");
  const codecs = format.getSupportedVideoCodecs().filter((codec) => codec === "avc");
  const codec = await getFirstEncodableVideoCodec(codecs, {
    width: CANVAS_SIZE,
    height: CANVAS_SIZE,
    bitrate: VIDEO_BITRATE
  });
  if (!codec) return null;

  const supportsConstantBitrate = await canEncodeVideo(codec, {
    width: CANVAS_SIZE,
    height: CANVAS_SIZE,
    bitrate: VIDEO_BITRATE,
    bitrateMode: "constant",
    latencyMode: "realtime"
  });
  return { codec, bitrateMode: supportsConstantBitrate ? "constant" as const : "variable" as const };
}

function waitForVideoMetadata(video: HTMLVideoElement) {
  return new Promise<void>((resolve, reject) => {
    if (Number.isFinite(video.duration) && video.videoWidth) {
      resolve();
      return;
    }
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("Timed out while loading video metadata."));
    }, 20_000);
    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener("loadedmetadata", handleMetadata);
      video.removeEventListener("error", handleError);
    };
    const handleMetadata = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error("Could not load video metadata."));
    };

    video.addEventListener("loadedmetadata", handleMetadata, { once: true });
    video.addEventListener("error", handleError, { once: true });
    video.load();
  });
}

async function sampleVideoFrames(
  video: HTMLVideoElement,
  onFrame: () => void | Promise<void>,
  onProgress?: (progress: DecodeVideoProgress) => void
) {
  video.pause();
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  if (duration <= 0) {
    await onFrame();
    onProgress?.({ phase: "Sampling frames", completed: 1, total: 1 });
    return;
  }

  const sampleFps = Math.max(VIDEO_FPS * 2, 60);
  const step = 1 / sampleFps;
  const finalTime = Math.max(0, duration - 0.001);
  const totalSamples = Math.floor(finalTime / step) + 2;
  let sampleIndex = 0;
  for (let time = 0; time <= finalTime; time += step) {
    await seekVideo(video, Math.min(time, finalTime));
    await onFrame();
    sampleIndex++;
    onProgress?.({ phase: "Sampling frames", completed: sampleIndex, total: totalSamples });
  }
  await seekVideo(video, finalTime);
  await onFrame();
  sampleIndex++;
  onProgress?.({ phase: "Sampling frames", completed: Math.min(sampleIndex, totalSamples), total: totalSamples });
}

function seekVideo(video: HTMLVideoElement, time: number) {
  return new Promise<void>((resolve, reject) => {
    if (Math.abs(video.currentTime - time) < 0.001 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      requestAnimationFrame(() => resolve());
      return;
    }

    const cleanup = () => {
      video.removeEventListener("seeked", handleSeeked);
      video.removeEventListener("error", handleError);
    };
    const handleSeeked = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error("Could not seek video for decoding."));
    };

    video.addEventListener("seeked", handleSeeked, { once: true });
    video.addEventListener("error", handleError, { once: true });
    video.currentTime = time;
  });
}

function packChunk(header: Header, payload: Uint8Array) {
  const legacyHeaderJson = encoder.encode(JSON.stringify(header));
  const headerJson = legacyHeaderJson.length <= HEADER_BYTES - 7
    ? legacyHeaderJson
    : encoder.encode(JSON.stringify(compactHeader(header)));
  if (headerJson.length > HEADER_BYTES - 7) {
    throw new Error("Header is too large for this codec. Use a shorter file name.");
  }
  const out = new Uint8Array(RAW_CHUNK_BYTES);
  out.set(MAGIC, 0);
  out[4] = VERSION;
  writeUint16(out, 5, headerJson.length);
  out.set(headerJson, 7);
  out.set(payload, HEADER_BYTES);
  return out;
}

function compactHeader(header: Header): CompactHeader {
  return {
    v: 2,
    k: header.kind === "xor" ? "x" : "d",
    n: header.fileName,
    m: header.mimeType,
    s: header.fileSize,
    h: header.fileHash,
    i: header.chunkIndex,
    t: header.totalChunks,
    l: header.payloadLength,
    c: header.chunkCrc,
    a: header.parityMemberIndexes,
    b: header.parityMemberLengths,
    p: header.parityStartIndex,
    q: header.parityMemberCount,
    r: header.parityLastMemberLength
  };
}

function normalizeHeader(header: Header | CompactHeader): Header {
  if (!("v" in header)) return header;
  return {
    kind: header.k === "x" ? "xor" : "data",
    fileName: header.n,
    mimeType: header.m,
    fileSize: header.s,
    fileHash: header.h,
    chunkIndex: header.i,
    totalChunks: header.t,
    payloadLength: header.l,
    chunkCrc: header.c,
    parityMemberIndexes: header.a,
    parityMemberLengths: header.b,
    parityStartIndex: header.p,
    parityMemberCount: header.q,
    parityLastMemberLength: header.r
  };
}

function bytesToSymbols(bytes: Uint8Array) {
  const symbols = new Array<number>(SYMBOL_COUNT).fill(0);
  const radix = BigInt(SYMBOL_RADIX);
  const blockCount = Math.ceil(bytes.length / SYMBOL_BLOCK_BYTES);
  for (let block = 0; block < blockCount; block++) {
    let value = 0n;
    const byteStart = block * SYMBOL_BLOCK_BYTES;
    for (let offset = 0; offset < SYMBOL_BLOCK_BYTES; offset++) {
      value = (value << 8n) | BigInt(bytes[byteStart + offset] ?? 0);
    }
    const symbolStart = block * SYMBOL_BLOCK_SIZE;
    for (let offset = SYMBOL_BLOCK_SIZE - 1; offset >= 0; offset--) {
      symbols[symbolStart + offset] = Number(value % radix);
      value /= radix;
    }
  }
  return symbols;
}

function bitsToBytes(symbols: number[]) {
  const radix = BigInt(SYMBOL_RADIX);
  const bytes = new Uint8Array(RAW_CHUNK_BYTES);
  const blockCount = Math.floor(symbols.length / SYMBOL_BLOCK_SIZE);
  for (let block = 0; block < blockCount; block++) {
    let value = 0n;
    const symbolStart = block * SYMBOL_BLOCK_SIZE;
    for (let offset = 0; offset < SYMBOL_BLOCK_SIZE; offset++) {
      value = value * radix + BigInt(symbols[symbolStart + offset] ?? 0);
    }
    const byteStart = block * SYMBOL_BLOCK_BYTES;
    for (let offset = SYMBOL_BLOCK_BYTES - 1; offset >= 0; offset--) {
      bytes[byteStart + offset] = Number(value & 255n);
      value >>= 8n;
    }
  }
  return bytes;
}

function legacyBitsToBytes(symbols: number[]) {
  let value = 0n;
  const radix = BigInt(SYMBOL_RADIX);
  for (const symbol of symbols) value = value * radix + BigInt(symbol);
  const bytes = new Uint8Array(Math.floor((SYMBOL_COUNT * Math.log2(SYMBOL_RADIX)) / 8));
  for (let i = bytes.length - 1; i >= 0; i--) {
    bytes[i] = Number(value & 255n);
    value >>= 8n;
  }
  return bytes;
}

function drawFrame(ctx: CanvasRenderingContext2D) {
  ctx.fillStyle = "#111111";
  ctx.fillRect(0, 0, CANVAS_SIZE, 12);
  ctx.fillRect(0, CANVAS_SIZE - 12, CANVAS_SIZE, 12);
  ctx.fillRect(0, 0, 12, CANVAS_SIZE);
  ctx.fillRect(CANVAS_SIZE - 12, 0, 12, CANVAS_SIZE);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(12, 12, CANVAS_SIZE - 24, CANVAS_SIZE - 24);
  drawFinder(ctx, 18, 18);
  drawFinder(ctx, CANVAS_SIZE - 60, 18);
  drawFinder(ctx, 18, CANVAS_SIZE - 60);
  drawFinder(ctx, CANVAS_SIZE - 60, CANVAS_SIZE - 60);
}

function drawFinder(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.fillStyle = "#111";
  ctx.fillRect(x, y, 42, 42);
  ctx.fillStyle = "#fff";
  ctx.fillRect(x + 7, y + 7, 28, 28);
  ctx.fillStyle = "#111";
  ctx.fillRect(x + 14, y + 14, 14, 14);
}

function drawCalibration(ctx: CanvasRenderingContext2D) {
  for (let i = 0; i < palette.length; i++) {
    const [r, g, b] = palette[i];
    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
    ctx.fillRect(242 + i * 48, 15, 24, 24);
  }
}

function readCalibrationSwatches(imageData: Uint8ClampedArray) {
  return palette.map((_, i) => sampleAverageRgb(imageData, 242 + i * 48 + 12, 15 + 12, 6));
}

function sampleRgb(imageData: Uint8ClampedArray, x: number, y: number) {
  const idx = (y * CANVAS_SIZE + x) * 4;
  return [imageData[idx], imageData[idx + 1], imageData[idx + 2]];
}

function sampleAverageRgb(imageData: Uint8ClampedArray, x: number, y: number, radius: number) {
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let yy = y - radius; yy <= y + radius; yy++) {
    for (let xx = x - radius; xx <= x + radius; xx++) {
      const sample = sampleRgb(imageData, xx, yy);
      r += sample[0];
      g += sample[1];
      b += sample[2];
      count++;
    }
  }
  return [r / count, g / count, b / count];
}

function sampleCellAverage(imageData: Uint8ClampedArray, col: number, row: number) {
  const x0 = GRID_ORIGIN + col * CELL_SIZE + 1;
  const y0 = GRID_ORIGIN + row * CELL_SIZE + 1;
  const size = CELL_SIZE - 2;
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let y = y0; y < y0 + size; y++) {
    for (let x = x0; x < x0 + size; x++) {
      const sample = sampleRgb(imageData, x, y);
      r += sample[0];
      g += sample[1];
      b += sample[2];
      count++;
    }
  }
  return [r / count, g / count, b / count];
}

function nearestPaletteIndex(rgb: number[], swatches: number[][]) {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < swatches.length; i++) {
    const dist = colorDistance(rgb, swatches[i]);
    if (dist < bestDistance) {
      bestDistance = dist;
      bestIndex = i;
    }
  }
  return bestIndex;
}

function colorDistance(a: number[], b: number[]) {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

function requiredContext(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D canvas is unavailable.");
  return ctx;
}

function writeUint16(out: Uint8Array, offset: number, value: number) {
  out[offset] = (value >> 8) & 255;
  out[offset + 1] = value & 255;
}

function readUint16(bytes: Uint8Array, offset: number) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

async function sha256Hex(bytes: Uint8Array) {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not export canvas."))), type, quality);
  });
}

function crc32(bytes: Uint8Array) {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}
