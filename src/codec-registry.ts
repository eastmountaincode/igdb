export const CODEC_REGISTRY_REVISION = "2026-08-hamming-v4-repair-index-validation";

export const SUPPORTED_CODEC_FORMATS = [
  {
    id: "hamming74-v4",
    label: "Hamming(7,4) four-symbol visual codec with cross-video repair",
    payloadVersions: [4],
    write: true
  },
  {
    id: "hamming74-v3",
    label: "Hamming(7,4) four-symbol visual codec",
    payloadVersions: [3],
    write: false
  },
  {
    id: "spatial-majority-v2",
    label: "Three-copy spatial-majority visual codec",
    payloadVersions: [2],
    write: false
  },
  {
    id: "colorgrid6-block-v1-v2",
    label: "Six-color radix-block visual codec",
    payloadVersions: [1, 2],
    write: false
  },
  {
    id: "colorgrid6-bigint-v1",
    label: "Legacy six-color whole-grid visual codec",
    payloadVersions: [1],
    write: false
  }
] as const;

export type CodecFormatId = (typeof SUPPORTED_CODEC_FORMATS)[number]["id"];
