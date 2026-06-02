# Instagram Pixel DB Notes

Project path:

```text
/Volumes/Lexar/everything/coding/instagram-pixel-db
```

Local dev URL:

```text
http://localhost:5177/
```

Run it with Next.js:

```text
npm run dev -- -p 5177
```

## Legacy Still-Image Codec

The still-image/carousel path remains in the low-level codec as a legacy helper, but the app UI now focuses on video because the throughput is much better.

```text
current app path: H.264 MP4 video encode/decode
still-image controls: hidden from the app UI
```

The interrupted 5px still-image experiment reached about 12.7 KB/image but failed checksums after JPEG simulation, so it is not currently safe without stronger decoding/error correction.

## Scraper Handoff Contract

The scraper/downloader can be developed separately from the codec. It should return ordered media blobs and any caption/index text it can recover.

```ts
export type InstagramPostAsset = {
  postUrl: string;
  captionText?: string;
  images?: Blob[];
  videos?: Blob[];
};
```

The codec layer should own:

```text
media blobs -> decoded chunks -> checksum verification -> file reassembly
```

The scraper layer should own:

```text
profile or post URL -> index discovery -> ordered media download
```

Current Next.js scaffold includes a scraper boundary:

```text
POST /api/instagram/scrape -> discovered media references + caption/warnings
GET /api/instagram/media?url=... -> proxied image/video blob
```

The scraper uses the `yt-dlp-exec` packaged `yt-dlp` binary and returns one best MP4 per Instagram video item. Lower-quality renditions of the same video are intentionally discarded; multiple returned videos should represent carousel parts to decode and merge.

The UI defaults to:

```text
https://www.instagram.com/ndrewboylan/
```

As of the first unauthenticated test, Instagram served an error shell for that profile URL and exposed no media references. That is treated as a clean warning state in the app, not as a decoded file failure.

## Video Direction

Video raises capacity by orders of magnitude because each frame can carry a chunk sheet.

Historical browser baseline:

```text
7.2 KB/frame payload, approximately
6-color radix palette
60 fps recorder
3 repeated frames per transmitted chunk
4 data chunks + 1 XOR parity chunk
source video bitrate: 25 Mbps
effective payload rate: ~114.9 KB/sec
55 second single-video cap: ~6.17 MB
tested payload: 1002.7 KB
tested output: 140 data chunks, 175 transmitted chunks, 525 frames, 8.8 seconds
legacy decode result: 140/140 data chunks recovered from generated WebM
```

Current source profile:

```text
7.2 KB/frame payload, approximately
6-color radix palette
6px cells, 156 x 156 symbol grid
30 fps recorder
6 repeated frames per transmitted chunk
temporal-vote decode across repeated frames
2 data chunks + 1 XOR parity chunk
source video bitrate: 12 Mbps
effective payload rate: ~23.9 KiB/sec
55 second single-video cap: ~1.28 MiB
8-video carousel theoretical cap: ~10.2 MiB
write path automatically splits larger files into ordered MP4 parts at this cap
write path encodes split MP4 parts one at a time to avoid concurrent H.264 encoder contention
write path streams chunk drawings directly into the MP4 encoder instead of pre-rendering every segment canvas
read path decodes carousel MP4 parts with a concurrency cap of 2
2-worker OffscreenCanvas rendering path exists in source but is disabled because generated MP4s decoded 0 chunks in local verification
local generated H.264 verification: 209/209 data chunks recovered from a 1.46 MB demo payload
```

Collapsed experiment routes:

```text
the old /experimental temporal-vote flow has been migrated into /
the old /audio probe verified the 16-byte DTMF/AAC side channel and has been folded into file recovery
standalone experiment pages have been removed so / is the single app surface
```

Current export target is H.264 MP4 with the moov atom placed at the front of the file. WebM export is intentionally not used because it is not useful for Instagram upload testing.

Failed experiments:

```text
30 fps / 2 repeat frames: 6/23 chunks recovered
60 fps / 4 repeat frames: 15/23 chunks recovered
4 colors / 60 fps / 3 repeat / no parity: 32/36 chunks recovered
4 colors / 60 fps / 3 repeat / 4+1 XOR parity / 12 Mbps: 35/36 chunks recovered
4 colors / 60 fps / 3 repeat / 4+1 XOR parity / 25 Mbps: 185/185 chunks recovered, 55s cap ~4.68 MB
8 colors / 30 fps / 3 repeat: 17/23 chunks recovered
8 colors / 5px / 30 fps / 4 repeat / 25 Mbps: 0 chunks recovered after Instagram transcode; uploaded video looked visibly blurry
8 colors / 6px / 30 fps / 4 repeat / 25 Mbps: 0 chunks recovered after Instagram transcode
8 colors / 6px / 30 fps / 6 repeat / 25 Mbps: 0 chunks recovered after Instagram transcode; local generated H.264 recovered 120/120
12 colors / 6px / 30 fps / 3 repeat / 25 Mbps: 0 chunks recovered from generated local H.264 MP4
6 colors / 6px / 30 fps / 3 repeat / 25 Mbps: 0 chunks recovered from generated local H.264 MP4
6 colors / 6px / 30 fps / 6 repeat / 25 Mbps / 2-worker OffscreenCanvas frame rendering: 0 chunks recovered from generated local H.264 MP4
```

The prior 6-color radix / 60 fps / 3-repeat / 4+1 XOR parity / 25 Mbps setting was first verified as a browser-generated WebM baseline. The current source uses a conservative 30 fps / 6-repeat / 2+1 XOR H.264 path with temporal-vote decoding.

The next optimization targets are:

```text
reduce repeat count after improving video frame sampling
test 4-color and 8-color video modes against Instagram-transcoded downloads
add forward error correction across chunk groups
add explicit video-frame sync markers and chunk-majority voting
try less random-looking symbol layouts to reduce video encoder stress
```

Relevant research directions:

- High-capacity color QR/barcode decoding: learned or calibrated color classification, cross-module color interference, geometric correction.
- Display-to-camera communication: frame synchronization, robust block layouts, color recognition, and DCT/spectral embedding.
- Video watermarking against H.264/H.265: inter-frame compression punishes high-frequency random noise; robust data should live in larger, stable, repeated blocks or transform-domain features.
