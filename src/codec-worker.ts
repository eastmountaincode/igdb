export {};

const MAGIC = [70, 84, 73, 71]; // FTIG
const VERSION = 1;
const SYMBOL_BLOCK_BYTES = 8;
const SYMBOL_BLOCK_SIZE = 25;

type ChunkKind = "data" | "xor";

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

type RenderRequest = {
  id: number;
  header: Header;
  profile: WorkerCodecProfile;
  payload: ArrayBuffer;
};

const encoder = new TextEncoder();
const worker = self as unknown as {
  onmessage: ((event: MessageEvent<RenderRequest>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

worker.onmessage = (event: MessageEvent<RenderRequest>) => {
  try {
    const bitmap = encodeChunk(event.data.profile, event.data.header, new Uint8Array(event.data.payload));
    worker.postMessage({ id: event.data.id, bitmap }, [bitmap]);
  } catch (error) {
    worker.postMessage({
      id: event.data.id,
      error: error instanceof Error ? error.message : String(error)
    });
  }
};

function encodeChunk(profile: WorkerCodecProfile, header: Header, payload: Uint8Array) {
  const canvas = new OffscreenCanvas(profile.canvasSize, profile.canvasSize);
  const ctx = requiredContext(canvas);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, profile.canvasSize, profile.canvasSize);
  drawFrame(profile, ctx);

  const packed = packChunk(profile, header, payload);
  const symbols = bytesToSymbols(profile, packed);
  let pointer = 0;
  for (let row = 0; row < profile.gridCells; row++) {
    for (let col = 0; col < profile.gridCells; col++) {
      const symbol = symbols[pointer++] ?? 0;
      const [r, g, b] = profile.palette[symbol];
      ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
      ctx.fillRect(
        profile.gridOrigin + col * profile.cellSize,
        profile.gridOrigin + row * profile.cellSize,
        profile.cellSize,
        profile.cellSize
      );
    }
  }

  drawCalibration(profile, ctx);
  return canvas.transferToImageBitmap();
}

function packChunk(profile: WorkerCodecProfile, header: Header, payload: Uint8Array) {
  const headerJson = encoder.encode(JSON.stringify(header));
  if (headerJson.length > profile.headerBytes - 7) {
    throw new Error("Header is too large for this codec. Use a shorter file name.");
  }
  const out = new Uint8Array(profile.rawChunkBytes);
  out.set(MAGIC, 0);
  out[4] = VERSION;
  writeUint16(out, 5, headerJson.length);
  out.set(headerJson, 7);
  out.set(payload, profile.headerBytes);
  return out;
}

function bytesToSymbols(profile: WorkerCodecProfile, bytes: Uint8Array) {
  const symbols = new Array<number>(profile.symbolCount).fill(0);
  const radix = BigInt(profile.symbolRadix);
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

function drawFrame(profile: WorkerCodecProfile, ctx: OffscreenCanvasRenderingContext2D) {
  ctx.fillStyle = "#111111";
  ctx.fillRect(0, 0, profile.canvasSize, 12);
  ctx.fillRect(0, profile.canvasSize - 12, profile.canvasSize, 12);
  ctx.fillRect(0, 0, 12, profile.canvasSize);
  ctx.fillRect(profile.canvasSize - 12, 0, 12, profile.canvasSize);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(12, 12, profile.canvasSize - 24, profile.canvasSize - 24);
  drawFinder(ctx, 18, 18);
  drawFinder(ctx, profile.canvasSize - 60, 18);
  drawFinder(ctx, 18, profile.canvasSize - 60);
  drawFinder(ctx, profile.canvasSize - 60, profile.canvasSize - 60);
}

function drawFinder(ctx: OffscreenCanvasRenderingContext2D, x: number, y: number) {
  ctx.fillStyle = "#111";
  ctx.fillRect(x, y, 42, 42);
  ctx.fillStyle = "#fff";
  ctx.fillRect(x + 7, y + 7, 28, 28);
  ctx.fillStyle = "#111";
  ctx.fillRect(x + 14, y + 14, 14, 14);
}

function drawCalibration(profile: WorkerCodecProfile, ctx: OffscreenCanvasRenderingContext2D) {
  for (let i = 0; i < profile.palette.length; i++) {
    const [r, g, b] = profile.palette[i];
    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
    ctx.fillRect(242 + i * 48, 15, 24, 24);
  }
}

function requiredContext(canvas: OffscreenCanvas) {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas is unavailable.");
  return ctx;
}

function writeUint16(out: Uint8Array, offset: number, value: number) {
  out[offset] = (value >> 8) & 255;
  out[offset + 1] = value & 255;
}
