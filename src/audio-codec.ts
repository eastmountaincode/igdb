export const AUDIO_PROBE_SAMPLE_RATE = 44_100;
export const AUDIO_PROBE_SYMBOL_SECONDS = 0.1;
export const AUDIO_PROBE_SYMBOL_REPEATS = 5;
export const AUDIO_PROBE_LOW_TONES = [697, 770, 852, 941] as const;
export const AUDIO_PROBE_HIGH_TONES = [1209, 1336, 1477, 1633] as const;
export const AUDIO_PROBE_AMPLITUDE = 0.42;
export const AUDIO_PROBE_DURATION_SECONDS = 30;
export const AUDIO_PROBE_PAYLOAD_BYTES = 16;

const PREAMBLE_SYMBOLS = [0xa, 0x5, 0xa, 0x5, 0xf, 0x0, 0xf, 0x0, 0xc, 0x3, 0xc, 0x3, 0x9, 0x6, 0x9, 0x6];
const BYTE_SYNC_SYMBOLS = [0xd, 0x2, 0xd, 0x2];
const SYMBOL_RATE_SEARCH_FACTORS = [0.97, 0.98, 0.99, 1, 1.01, 1.02, 1.03];
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

export type AudioProbePayload = {
  text: string;
  bytes: Uint8Array;
  bitString: string;
  nibbles: number[];
  durationSeconds: number;
};

export type AudioProbeDecodeResult = {
  ok: boolean;
  text: string;
  bitErrors: number;
  totalBits: number;
  byteErrors: number;
  totalBytes: number;
  confidence: number;
  message: string;
};

export type AudioProbeBytesDecodeResult = {
  ok: boolean;
  bytes: Uint8Array;
  confidence: number;
  message: string;
};

export function buildAudioProbePayload(text = "FTIG AUDIO PROBE") {
  const bytes = TEXT_ENCODER.encode(text);
  return buildAudioProbePayloadFromBytes(bytes);
}

export function buildAudioProbePayloadForBytes(byteLength: number) {
  const source = "FTIG-AUDIO-PROBE|0123456789ABCDEF|";
  let text = "";
  while (text.length < byteLength) text += source;
  return buildAudioProbePayload(text.slice(0, byteLength));
}

export function buildAudioProbePayloadFromBytes(bytes: Uint8Array) {
  const text = TEXT_DECODER.decode(bytes);
  const bitString = bytesToBits(bytes);
  const nibbles = bytesToNibbles(bytes);
  const symbolCount = PREAMBLE_SYMBOLS.length + bytes.length * (AUDIO_PROBE_SYMBOL_REPEATS * 2 + BYTE_SYNC_SYMBOLS.length) + 2;
  return {
    text,
    bytes,
    bitString,
    nibbles,
    durationSeconds: Math.max(AUDIO_PROBE_DURATION_SECONDS, symbolCount * AUDIO_PROBE_SYMBOL_SECONDS)
  };
}

export function synthesizeDtmfProbe(payload: AudioProbePayload) {
  const framedSymbols = buildFramedSymbols(payload);
  const totalSamples = Math.ceil(payload.durationSeconds * AUDIO_PROBE_SAMPLE_RATE);
  const samples = new Float32Array(totalSamples);
  const samplesPerSymbol = Math.round(AUDIO_PROBE_SYMBOL_SECONDS * AUDIO_PROBE_SAMPLE_RATE);
  let cursor = 0;

  for (const symbol of framedSymbols) {
    const lowFrequency = AUDIO_PROBE_LOW_TONES[Math.floor(symbol / 4)];
    const highFrequency = AUDIO_PROBE_HIGH_TONES[symbol % 4];
    for (let i = 0; i < samplesPerSymbol && cursor < samples.length; i++, cursor++) {
      const envelope = raisedCosineEnvelope(i, samplesPerSymbol);
      const low = Math.sin((2 * Math.PI * lowFrequency * cursor) / AUDIO_PROBE_SAMPLE_RATE);
      const high = Math.sin((2 * Math.PI * highFrequency * cursor) / AUDIO_PROBE_SAMPLE_RATE);
      samples[cursor] = ((low + high) / 2) * AUDIO_PROBE_AMPLITUDE * envelope;
    }
  }

  return samples;
}

export async function decodeDtmfProbeFromFile(file: File, expectedPayload = buildAudioProbePayload()): Promise<AudioProbeDecodeResult> {
  const audioContext = new AudioContext({ sampleRate: AUDIO_PROBE_SAMPLE_RATE });
  try {
    const buffer = await audioContext.decodeAudioData(await file.arrayBuffer());
    const mono = mixToMono(buffer);
    return decodeDtmfProbeSamples(mono, buffer.sampleRate, expectedPayload);
  } finally {
    await audioContext.close();
  }
}

export async function decodeDtmfProbeBytesFromFile(file: File, byteLength = AUDIO_PROBE_PAYLOAD_BYTES): Promise<AudioProbeBytesDecodeResult> {
  const audioContext = new AudioContext({ sampleRate: AUDIO_PROBE_SAMPLE_RATE });
  try {
    const buffer = await audioContext.decodeAudioData(await file.arrayBuffer());
    const mono = mixToMono(buffer);
    return decodeDtmfProbeBytes(mono, buffer.sampleRate, byteLength);
  } finally {
    await audioContext.close();
  }
}

export async function decodeDtmfProbeBytePacketsFromFile(
  file: File,
  packetCount: number,
  byteLength = AUDIO_PROBE_PAYLOAD_BYTES
): Promise<AudioProbeBytesDecodeResult[]> {
  const audioContext = new AudioContext({ sampleRate: AUDIO_PROBE_SAMPLE_RATE });
  try {
    const buffer = await audioContext.decodeAudioData(await file.arrayBuffer());
    const mono = mixToMono(buffer);
    const packetSamples = Math.round(AUDIO_PROBE_DURATION_SECONDS * buffer.sampleRate);
    const overlapSamples = Math.round(2 * buffer.sampleRate);
    const results: AudioProbeBytesDecodeResult[] = [];
    for (let packetIndex = 0; packetIndex < packetCount; packetIndex++) {
      const nominalStart = packetIndex * packetSamples;
      const start = Math.max(0, nominalStart - overlapSamples);
      const end = Math.min(mono.length, nominalStart + packetSamples + overlapSamples);
      results.push(decodeDtmfProbeBytes(mono.slice(start, end), buffer.sampleRate, byteLength));
    }
    return results;
  } finally {
    await audioContext.close();
  }
}

export function synthesizeDtmfProbePackets(payloads: Uint8Array[]) {
  const packetSamples = Math.ceil(AUDIO_PROBE_DURATION_SECONDS * AUDIO_PROBE_SAMPLE_RATE);
  const samples = new Float32Array(packetSamples * payloads.length);
  for (let packetIndex = 0; packetIndex < payloads.length; packetIndex++) {
    const packet = synthesizeDtmfProbe(buildAudioProbePayloadFromBytes(payloads[packetIndex]));
    samples.set(packet.slice(0, packetSamples), packetIndex * packetSamples);
  }
  return samples;
}

export function decodeDtmfProbeBytes(samples: Float32Array, sampleRate: number, byteLength = AUDIO_PROBE_PAYLOAD_BYTES): AudioProbeBytesDecodeResult {
  const alignment = findBestAlignment(samples, sampleRate, byteLength);
  let bestPayload: { nibbles: number[]; score: number } | null = null;
  for (let byteBlockShift = -4; byteBlockShift <= 4; byteBlockShift++) {
    const payload = decodeByteFramedPayload(samples, sampleRate, alignment.offset, alignment.samplesPerSymbol, byteLength, byteBlockShift);
    if (!bestPayload || payload.score > bestPayload.score) bestPayload = payload;
  }
  const decodedBytes = nibblesToBytes(bestPayload?.nibbles ?? new Array<number>(byteLength * 2).fill(0));
  const confidence = Math.max(0, Math.min(1, (alignment.preambleMatches / PREAMBLE_SYMBOLS.length + Math.max(0, bestPayload?.score ?? 0) / (byteLength * BYTE_SYNC_SYMBOLS.length * 2)) / 2));
  return {
    ok: confidence >= 0.3,
    bytes: decodedBytes,
    confidence,
    message: confidence >= 0.3 ? "Audio bytes decoded." : "Audio bytes decoded with weak sync confidence."
  };
}

export function decodeDtmfProbeSamples(samples: Float32Array, sampleRate: number, expectedPayload = buildAudioProbePayload()): AudioProbeDecodeResult {
  const alignment = findBestAlignment(samples, sampleRate, expectedPayload.bytes.length);

  const byteBlockSymbols = AUDIO_PROBE_SYMBOL_REPEATS * 2 + BYTE_SYNC_SYMBOLS.length;
  const neededSymbols = PREAMBLE_SYMBOLS.length + expectedPayload.bytes.length * byteBlockSymbols;
  const decodedSymbols = demodulateDtmfSymbols(samples, sampleRate, alignment.offset, neededSymbols, alignment.samplesPerSymbol);
  const preambleMatches = PREAMBLE_SYMBOLS.reduce((count, symbol, index) => count + (decodedSymbols[index] === symbol ? 1 : 0), 0);
  const confidence = preambleMatches / PREAMBLE_SYMBOLS.length;
  let bestResult: AudioProbeDecodeResult | null = null;

  for (let byteBlockShift = -4; byteBlockShift <= 4; byteBlockShift++) {
    const payload = decodeByteFramedPayload(samples, sampleRate, alignment.offset, alignment.samplesPerSymbol, expectedPayload.bytes.length, byteBlockShift);
    const decodedBytes = nibblesToBytes(payload.nibbles);
    const result = buildDecodeResult(decodedBytes, expectedPayload, confidence, byteBlockShift);
    if (!bestResult || result.bitErrors < bestResult.bitErrors) bestResult = result;
  }

  return bestResult ?? buildDecodeResult(new Uint8Array(expectedPayload.bytes.length), expectedPayload, confidence, 0);
}

function findBestAlignment(samples: Float32Array, sampleRate: number, byteLength: number) {
  const preambleLength = PREAMBLE_SYMBOLS.length;
  const byteBlockSymbols = AUDIO_PROBE_SYMBOL_REPEATS * 2 + BYTE_SYNC_SYMBOLS.length;
  const neededSymbols = preambleLength + byteLength * byteBlockSymbols;
  const alignmentProbeSymbols = Math.min(neededSymbols, preambleLength + 5 * byteBlockSymbols);

  let bestOffset = 0;
  let bestSamplesPerSymbol = Math.round(AUDIO_PROBE_SYMBOL_SECONDS * sampleRate);
  let bestScore = Number.NEGATIVE_INFINITY;
  let bestPreambleMatches = 0;
  for (const factor of SYMBOL_RATE_SEARCH_FACTORS) {
    const samplesPerSymbol = Math.max(1, Math.round(AUDIO_PROBE_SYMBOL_SECONDS * sampleRate * factor));
    const maxOffsetSamples = Math.max(0, Math.min(samples.length - neededSymbols * samplesPerSymbol, Math.round(sampleRate * 6)));
    const offsetStep = Math.max(1, Math.floor(samplesPerSymbol / 5));
    for (let offset = 0; offset <= maxOffsetSamples; offset += offsetStep) {
      const symbols = demodulateDtmfSymbols(samples, sampleRate, offset, alignmentProbeSymbols, samplesPerSymbol);
      const score = alignmentScore(symbols);
      if (score > bestScore) {
        bestScore = score;
        bestOffset = offset;
        bestSamplesPerSymbol = samplesPerSymbol;
        bestPreambleMatches = PREAMBLE_SYMBOLS.reduce((count, symbol, index) => count + (symbols[index] === symbol ? 1 : 0), 0);
      }
    }
  }
  return { offset: bestOffset, samplesPerSymbol: bestSamplesPerSymbol, preambleMatches: bestPreambleMatches };
}

function buildFramedSymbols(payload: AudioProbePayload) {
  const symbols = [...PREAMBLE_SYMBOLS];
  for (let byteIndex = 0; byteIndex < payload.bytes.length; byteIndex++) {
    const highNibble = (payload.bytes[byteIndex] >> 4) & 0xf;
    const lowNibble = payload.bytes[byteIndex] & 0xf;
    for (let repeat = 0; repeat < AUDIO_PROBE_SYMBOL_REPEATS; repeat++) symbols.push(highNibble);
    for (let repeat = 0; repeat < AUDIO_PROBE_SYMBOL_REPEATS; repeat++) symbols.push(lowNibble);
    symbols.push(...BYTE_SYNC_SYMBOLS);
  }
  return symbols;
}

function decodeByteFramedPayload(samples: Float32Array, sampleRate: number, preambleOffset: number, samplesPerSymbol: number, byteCount: number, byteBlockShift: number) {
  const nibbles: number[] = [];
  let totalScore = 0;
  const byteBlockSymbols = AUDIO_PROBE_SYMBOL_REPEATS * 2 + BYTE_SYNC_SYMBOLS.length;
  const payloadOffset = preambleOffset + PREAMBLE_SYMBOLS.length * samplesPerSymbol;
  const searchRadius = Math.floor(samplesPerSymbol * 0.75);
  const searchStep = Math.max(1, Math.floor(samplesPerSymbol / 8));

  for (let byteIndex = 0; byteIndex < byteCount; byteIndex++) {
    const predictedOffset = payloadOffset + (byteIndex + byteBlockShift) * byteBlockSymbols * samplesPerSymbol;
    let bestBlockSymbols: number[] | null = null;
    let bestBlockScore = Number.NEGATIVE_INFINITY;

    for (let delta = -searchRadius; delta <= searchRadius; delta += searchStep) {
      const candidateOffset = predictedOffset + delta;
      if (candidateOffset < 0) continue;
      const blockSymbols = demodulateDtmfSymbols(samples, sampleRate, candidateOffset, byteBlockSymbols, samplesPerSymbol);
      const score = byteSyncScore(blockSymbols);
      if (score > bestBlockScore) {
        bestBlockScore = score;
        bestBlockSymbols = blockSymbols;
      }
    }

    const block = bestBlockSymbols ?? new Array<number>(byteBlockSymbols).fill(0);
    totalScore += bestBlockScore;
    nibbles.push(
      majorityVoteSymbol(block.slice(0, AUDIO_PROBE_SYMBOL_REPEATS)),
      majorityVoteSymbol(block.slice(AUDIO_PROBE_SYMBOL_REPEATS, AUDIO_PROBE_SYMBOL_REPEATS * 2))
    );
  }

  return { nibbles, score: totalScore };
}

function buildDecodeResult(decodedBytes: Uint8Array, expectedPayload: AudioProbePayload, confidence: number, byteBlockShift: number): AudioProbeDecodeResult {
  const decodedBits = bytesToBits(decodedBytes);
  const payloadBits = expectedPayload.bitString.length;
  let bitErrors = 0;
  for (let i = 0; i < payloadBits; i++) {
    if (decodedBits[i] !== expectedPayload.bitString[i]) bitErrors++;
  }

  let byteErrors = 0;
  for (let i = 0; i < expectedPayload.bytes.length; i++) {
    if (decodedBytes[i] !== expectedPayload.bytes[i]) byteErrors++;
  }

  const shiftNote = byteBlockShift === 0 ? "" : ` Best byte alignment shifted ${byteBlockShift > 0 ? "+" : ""}${byteBlockShift}.`;
  return {
    ok: bitErrors === 0,
    text: TEXT_DECODER.decode(decodedBytes),
    bitErrors,
    totalBits: payloadBits,
    byteErrors,
    totalBytes: expectedPayload.bytes.length,
    confidence,
    message: bitErrors === 0 ? `Audio probe decoded without bit errors.${shiftNote}` : `Audio probe decoded with symbol errors.${shiftNote}`
  };
}

function demodulateDtmfSymbols(samples: Float32Array, sampleRate: number, offset: number, symbolCount: number, samplesPerSymbol: number) {
  const windowInset = Math.floor(samplesPerSymbol * 0.18);
  const windowLength = Math.max(1, samplesPerSymbol - windowInset * 2);
  const symbols: number[] = [];
  for (let symbolIndex = 0; symbolIndex < symbolCount; symbolIndex++) {
    const start = offset + symbolIndex * samplesPerSymbol;
    if (start + samplesPerSymbol >= samples.length) {
      symbols.push(0);
      continue;
    }
    const windowStart = start + windowInset;
    const lowIndex = maxEnergyToneIndex(samples, windowStart, windowLength, sampleRate, AUDIO_PROBE_LOW_TONES);
    const highIndex = maxEnergyToneIndex(samples, windowStart, windowLength, sampleRate, AUDIO_PROBE_HIGH_TONES);
    symbols.push(lowIndex * 4 + highIndex);
  }
  return symbols;
}

function maxEnergyToneIndex(samples: Float32Array, start: number, length: number, sampleRate: number, tones: readonly number[]) {
  let bestIndex = 0;
  let bestEnergy = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < tones.length; i++) {
    const energy = goertzelEnergy(samples, start, length, sampleRate, tones[i]);
    if (energy > bestEnergy) {
      bestEnergy = energy;
      bestIndex = i;
    }
  }
  return bestIndex;
}

function majorityVoteSymbol(symbols: number[]) {
  const counts = new Array<number>(16).fill(0);
  for (const symbol of symbols) counts[symbol ?? 0]++;
  let bestSymbol = 0;
  let bestCount = Number.NEGATIVE_INFINITY;
  for (let symbol = 0; symbol < counts.length; symbol++) {
    if (counts[symbol] > bestCount) {
      bestCount = counts[symbol];
      bestSymbol = symbol;
    }
  }
  return bestSymbol;
}

function goertzelEnergy(samples: Float32Array, start: number, length: number, sampleRate: number, frequency: number) {
  const omega = (2 * Math.PI * frequency) / sampleRate;
  const coeff = 2 * Math.cos(omega);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < length; i++) {
    s0 = samples[start + i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

function mixToMono(buffer: AudioBuffer) {
  const out = new Float32Array(buffer.length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const input = buffer.getChannelData(channel);
    for (let i = 0; i < input.length; i++) out[i] += input[i] / buffer.numberOfChannels;
  }
  return out;
}

function preambleScore(symbols: number[]) {
  let score = 0;
  for (let i = 0; i < PREAMBLE_SYMBOLS.length; i++) {
    score += symbols[i] === PREAMBLE_SYMBOLS[i] ? 1 : -1;
  }
  return score;
}

function byteSyncScore(symbols: number[]) {
  let score = 0;
  const syncStart = AUDIO_PROBE_SYMBOL_REPEATS * 2;
  for (let i = 0; i < BYTE_SYNC_SYMBOLS.length; i++) {
    score += symbols[syncStart + i] === BYTE_SYNC_SYMBOLS[i] ? 2 : -1;
  }
  return score;
}

function alignmentScore(symbols: number[]) {
  let score = preambleScore(symbols);
  const byteBlockSymbols = AUDIO_PROBE_SYMBOL_REPEATS * 2 + BYTE_SYNC_SYMBOLS.length;
  const byteCount = Math.floor((symbols.length - PREAMBLE_SYMBOLS.length) / byteBlockSymbols);
  for (let byteIndex = 0; byteIndex < byteCount; byteIndex++) {
    const syncStart = PREAMBLE_SYMBOLS.length + byteIndex * byteBlockSymbols + AUDIO_PROBE_SYMBOL_REPEATS * 2;
    for (let i = 0; i < BYTE_SYNC_SYMBOLS.length; i++) {
      score += symbols[syncStart + i] === BYTE_SYNC_SYMBOLS[i] ? 2 : -1;
    }
  }
  return score;
}

function bytesToNibbles(bytes: Uint8Array) {
  const nibbles: number[] = [];
  for (const byte of bytes) {
    nibbles.push((byte >> 4) & 0xf, byte & 0xf);
  }
  return nibbles;
}

function nibblesToBytes(nibbles: number[]) {
  const bytes = new Uint8Array(Math.floor(nibbles.length / 2));
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = ((nibbles[i * 2] & 0xf) << 4) | (nibbles[i * 2 + 1] & 0xf);
  }
  return bytes;
}

function bytesToBits(bytes: Uint8Array) {
  let bits = "";
  for (const byte of bytes) bits += byte.toString(2).padStart(8, "0");
  return bits;
}

function raisedCosineEnvelope(index: number, length: number) {
  const edge = Math.max(1, Math.floor(length * 0.12));
  if (index < edge) return 0.5 - 0.5 * Math.cos((Math.PI * index) / edge);
  if (index > length - edge) return 0.5 - 0.5 * Math.cos((Math.PI * (length - index)) / edge);
  return 1;
}
