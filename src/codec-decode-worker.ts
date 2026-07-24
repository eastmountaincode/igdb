export {};

const MAGIC = [70, 84, 73, 71];
const VERSION = 3;
const SYMBOL_BLOCK_BYTES = 8;
const SYMBOL_BLOCK_SIZE = 25;
const SPATIAL_SYMBOL_COPIES = 3;
const HAMMING_DATA_SYMBOLS = 4;
const HAMMING_CODE_SYMBOLS = 7;

type ChunkKind = "data" | "xor" | "rs";

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
  chunkBindingCrc?: number;
  parityMemberIndexes?: number[];
  parityMemberLengths?: number[];
  parityStartIndex?: number;
  parityMemberCount?: number;
  parityLastMemberLength?: number;
  parityRow?: number;
};

type CompactHeader = {
  v: 2;
  k: "d" | "x" | "r";
  n: string;
  m: string;
  s: number;
  h: string;
  i: number;
  t: number;
  l: number;
  c: number;
  d?: number;
  a?: number[];
  b?: number[];
  p?: number;
  q?: number;
  r?: number;
  u?: number;
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

type DecodeRequest = {
  id: number;
  profile: WorkerCodecProfile;
  imageData: ArrayBuffer;
};

type DecodeResult = {
  ok: boolean;
  kind: ChunkKind;
  fileName: string;
  mimeType: string;
  fileSize: number;
  fileHash: string;
  chunkIndex: number;
  totalChunks: number;
  payload: ArrayBuffer;
  message: string;
  parityMemberIndexes?: number[];
  parityMemberLengths?: number[];
  parityRow?: number;
};

const decoder = new TextDecoder();
const worker = self as unknown as {
  onmessage: ((event: MessageEvent<DecodeRequest>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

worker.onmessage = (event: MessageEvent<DecodeRequest>) => {
  try {
    const result = decodeImageData(event.data.profile, new Uint8ClampedArray(event.data.imageData));
    worker.postMessage({ id: event.data.id, result }, [result.payload]);
  } catch (error) {
    worker.postMessage({
      id: event.data.id,
      error: error instanceof Error ? error.message : String(error)
    });
  }
};

function decodeImageData(profile: WorkerCodecProfile, imageData: Uint8ClampedArray): DecodeResult {
  const symbols: number[] = [];
  const swatches = readCalibrationSwatches(profile, imageData);
  for (let row = 0; row < profile.gridCells; row++) {
    for (let col = 0; col < profile.gridCells; col++) {
      symbols.push(nearestPaletteIndex(sampleCellAverage(profile, imageData, col, row), swatches));
    }
  }

  const spatialSymbolCount = Math.floor(profile.symbolCount / SPATIAL_SYMBOL_COPIES);
  const spatialRawChunkBytes = Math.floor(spatialSymbolCount / SYMBOL_BLOCK_SIZE) * SYMBOL_BLOCK_BYTES;
  const legacyRawChunkBytes = Math.floor(profile.symbolCount / SYMBOL_BLOCK_SIZE) * SYMBOL_BLOCK_BYTES;
  try {
    return decodeChunkBytes(profile, hammingDecodeSymbols(profile, symbols));
  } catch {
    try {
      return decodeChunkBytes(profile, bitsToBytes(profile, spatialMajoritySymbols(profile, symbols), spatialRawChunkBytes));
    } catch {
      try {
        return decodeChunkBytes(profile, bitsToBytes(profile, symbols, legacyRawChunkBytes));
      } catch {
        return decodeChunkBytes(profile, legacyBitsToBytes(profile, symbols));
      }
    }
  }
}

function hammingDecodeSymbols(profile: WorkerCodecProfile, symbols: number[]) {
  const sourceSymbolCount = Math.floor(profile.symbolCount / HAMMING_CODE_SYMBOLS) * HAMMING_DATA_SYMBOLS;
  const dataSymbols: number[] = [];
  const groupCount = Math.floor(sourceSymbolCount / HAMMING_DATA_SYMBOLS);
  for (let group = 0; group < groupCount; group++) {
    const code = symbols.slice(group * HAMMING_CODE_SYMBOLS, group * HAMMING_CODE_SYMBOLS + HAMMING_CODE_SYMBOLS);
    const data = [0, 0, 0, 0];
    for (let bit = 0; bit < 2; bit++) {
      const plane = code.map((symbol) => (symbol >> bit) & 1);
      const syndrome =
        (plane[0] ^ plane[2] ^ plane[4] ^ plane[6]) |
        ((plane[1] ^ plane[2] ^ plane[5] ^ plane[6]) << 1) |
        ((plane[3] ^ plane[4] ^ plane[5] ^ plane[6]) << 2);
      if (syndrome > 0 && syndrome <= HAMMING_CODE_SYMBOLS) plane[syndrome - 1] ^= 1;
      const decoded = [plane[2], plane[4], plane[5], plane[6]];
      for (let index = 0; index < data.length; index++) data[index] |= decoded[index] << bit;
    }
    dataSymbols.push(...data);
  }
  const bytes = new Uint8Array(profile.rawChunkBytes);
  for (let index = 0; index < bytes.length; index++) {
    const offset = index * 4;
    bytes[index] =
      ((dataSymbols[offset] ?? 0) << 6) |
      ((dataSymbols[offset + 1] ?? 0) << 4) |
      ((dataSymbols[offset + 2] ?? 0) << 2) |
      (dataSymbols[offset + 3] ?? 0);
  }
  return bytes;
}

function spatialMajoritySymbols(profile: WorkerCodecProfile, symbols: number[]) {
  const spatialSymbolCount = Math.floor(profile.symbolCount / SPATIAL_SYMBOL_COPIES);
  const logical = new Array<number>(spatialSymbolCount).fill(0);
  for (let index = 0; index < spatialSymbolCount; index++) {
    const counts = new Array<number>(profile.symbolRadix).fill(0);
    counts[symbols[index] ?? 0]++;
    counts[symbols[index + spatialSymbolCount] ?? 0]++;
    counts[symbols[index + spatialSymbolCount * 2] ?? 0]++;
    let best = 0;
    for (let symbol = 1; symbol < counts.length; symbol++) {
      if (counts[symbol] > counts[best]) best = symbol;
    }
    logical[index] = best;
  }
  return logical;
}

function decodeChunkBytes(profile: WorkerCodecProfile, allBytes: Uint8Array): DecodeResult {
  if (!MAGIC.every((byte, index) => allBytes[index] === byte) || ![1, 2, VERSION].includes(allBytes[4])) {
    throw new Error("Unknown video payload format.");
  }
  const headerLength = readUint16(allBytes, 5);
  if (headerLength <= 0 || headerLength > profile.headerBytes - 7) throw new Error("Invalid video payload header.");
  const headerJson = decoder.decode(allBytes.slice(7, 7 + headerLength));
  const header = normalizeHeader(JSON.parse(headerJson) as Header | CompactHeader);
  const payloadStart = profile.headerBytes;
  const payload = allBytes.slice(payloadStart, payloadStart + header.payloadLength);
  const crcOk = crc32(payload) === header.chunkCrc
    && (header.chunkBindingCrc === undefined || boundChunkCrc(header.chunkIndex, payload) === header.chunkBindingCrc);
  const payloadBuffer = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) as ArrayBuffer;
  const parityMembers = expandParityMembers(header, allBytes.length - profile.headerBytes);

  return {
    ok: crcOk,
    kind: header.kind ?? "data",
    fileName: header.fileName,
    mimeType: header.mimeType,
    fileSize: header.fileSize,
    fileHash: header.fileHash,
    chunkIndex: header.chunkIndex,
    totalChunks: header.totalChunks,
    payload: payloadBuffer,
    message: crcOk ? "decoded" : "decoded with checksum mismatch",
    parityMemberIndexes: parityMembers.indexes,
    parityMemberLengths: parityMembers.lengths,
    parityRow: header.parityRow
  };
}

function normalizeHeader(header: Header | CompactHeader): Header {
  if (!("v" in header)) return header;
  return {
    kind: header.k === "x" ? "xor" : header.k === "r" ? "rs" : "data",
    fileName: header.n,
    mimeType: header.m,
    fileSize: header.s,
    fileHash: header.h,
    chunkIndex: header.i,
    totalChunks: header.t,
    payloadLength: header.l,
    chunkCrc: header.c,
    chunkBindingCrc: header.d,
    parityMemberIndexes: header.a,
    parityMemberLengths: header.b,
    parityStartIndex: header.p,
    parityMemberCount: header.q,
    parityLastMemberLength: header.r,
    parityRow: header.u
  };
}

function expandParityMembers(header: Header, payloadCapacity: number) {
  if (header.parityMemberIndexes?.length) {
    return { indexes: header.parityMemberIndexes, lengths: header.parityMemberLengths ?? [] };
  }
  const count = header.parityMemberCount ?? 0;
  const start = header.parityStartIndex ?? 0;
  const indexes = Array.from({ length: count }, (_, index) => start + index);
  const lengths = new Array<number>(count).fill(payloadCapacity);
  if (count && header.parityLastMemberLength !== undefined) lengths[count - 1] = header.parityLastMemberLength;
  return { indexes, lengths };
}

function bitsToBytes(profile: WorkerCodecProfile, symbols: number[], byteLength = profile.rawChunkBytes) {
  const radix = BigInt(profile.symbolRadix);
  const bytes = new Uint8Array(byteLength);
  const blockCount = Math.min(Math.floor(symbols.length / SYMBOL_BLOCK_SIZE), Math.ceil(byteLength / SYMBOL_BLOCK_BYTES));
  for (let block = 0; block < blockCount; block++) {
    let value = 0n;
    const symbolStart = block * SYMBOL_BLOCK_SIZE;
    for (let offset = 0; offset < SYMBOL_BLOCK_SIZE; offset++) {
      value = value * radix + BigInt(symbols[symbolStart + offset] ?? 0);
    }
    const byteStart = block * SYMBOL_BLOCK_BYTES;
    for (let offset = SYMBOL_BLOCK_BYTES - 1; offset >= 0; offset--) {
      if (byteStart + offset < bytes.length) bytes[byteStart + offset] = Number(value & 255n);
      value >>= 8n;
    }
  }
  return bytes;
}

function legacyBitsToBytes(profile: WorkerCodecProfile, symbols: number[]) {
  let value = 0n;
  const radix = BigInt(profile.symbolRadix);
  for (const symbol of symbols) value = value * radix + BigInt(symbol);
  const bytes = new Uint8Array(Math.floor((profile.symbolCount * Math.log2(profile.symbolRadix)) / 8));
  for (let i = bytes.length - 1; i >= 0; i--) {
    bytes[i] = Number(value & 255n);
    value >>= 8n;
  }
  return bytes;
}

function readCalibrationSwatches(profile: WorkerCodecProfile, imageData: Uint8ClampedArray) {
  return profile.palette.map((_, i) => sampleAverageRgb(profile, imageData, 242 + i * 48 + 12, 15 + 12, 6));
}

function sampleRgb(profile: WorkerCodecProfile, imageData: Uint8ClampedArray, x: number, y: number) {
  const idx = (y * profile.canvasSize + x) * 4;
  return [imageData[idx], imageData[idx + 1], imageData[idx + 2]];
}

function sampleAverageRgb(profile: WorkerCodecProfile, imageData: Uint8ClampedArray, x: number, y: number, radius: number) {
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let yy = y - radius; yy <= y + radius; yy++) {
    for (let xx = x - radius; xx <= x + radius; xx++) {
      const sample = sampleRgb(profile, imageData, xx, yy);
      r += sample[0];
      g += sample[1];
      b += sample[2];
      count++;
    }
  }
  return [r / count, g / count, b / count];
}

function sampleCellAverage(profile: WorkerCodecProfile, imageData: Uint8ClampedArray, col: number, row: number) {
  const x0 = profile.gridOrigin + col * profile.cellSize + 1;
  const y0 = profile.gridOrigin + row * profile.cellSize + 1;
  const size = profile.cellSize - 2;
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let y = y0; y < y0 + size; y++) {
    for (let x = x0; x < x0 + size; x++) {
      const sample = sampleRgb(profile, imageData, x, y);
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

function readUint16(bytes: Uint8Array, offset: number) {
  return (bytes[offset] << 8) | bytes[offset + 1];
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

function boundChunkCrc(chunkIndex: number, payload: Uint8Array) {
  const bytes = new Uint8Array(payload.length + 4);
  bytes[0] = chunkIndex >>> 24;
  bytes[1] = chunkIndex >>> 16;
  bytes[2] = chunkIndex >>> 8;
  bytes[3] = chunkIndex;
  bytes.set(payload, 4);
  return crc32(bytes);
}
