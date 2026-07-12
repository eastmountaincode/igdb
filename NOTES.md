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

## Automatic Instagram Upload Experiment

The `experiment/instagram-auto-upload` branch is the Zo-hosted experiment for posting generated videos through a persistent browser session.

The generated videos currently exist only as in-memory browser `Blob` objects. Automatic posting therefore requires a server handoff rather than calling the Instagram browser directly from this page:

```text
generated MP4 blob(s) + user caption
  -> staged upload on Zo
  -> durable queued job
  -> one-at-a-time browser worker using a dedicated Instagram profile
  -> post status and cleanup
```

For multiple generated videos, preserve `segmentIndex` ordering and submit them as one carousel when Instagram permits the complete set. Jobs need explicit destination-account confirmation, idempotency protection, retry-safe status transitions, and retained error evidence without storing Instagram credentials in the repository.

The Meta API path was proven against `@normal_shopkeep` on 2026-07-11: a generated MP4 container reached `FINISHED` and was published as a Reel. `feature/instagram-api-upload` integrates that flow into the generated-video UI. A single MP4 is published as a Reel; 2–8 ordered MP4s are published as one carousel. The caption format is file name, file type, file size, then an optional user note.

Relevant research directions:

- High-capacity color QR/barcode decoding: learned or calibrated color classification, cross-module color interference, geometric correction.
- Display-to-camera communication: frame synchronization, robust block layouts, color recognition, and DCT/spectral embedding.
- Video watermarking against H.264/H.265: inter-frame compression punishes high-frequency random noise; robust data should live in larger, stable, repeated blocks or transform-domain features.

## 2026-07-12 Encoding Performance Experiment

Accepted codec settings on `experiment/encode-performance`:

```text
720x720 canvas / 4px cells / 6 colors
30 fps / 3 repeats / XOR parity 16+1
6 Mbps H.264 / constant bitrate / realtime latency mode
two segment encoders for multi-video files
video-only payloads on every browser; the environment-dependent AAC path is bypassed
realtime VBR fallback when the browser cannot encode constant-bitrate H.264
compact parity headers store contiguous start/count/last-length metadata instead of redundant arrays
independent 8-byte / 25-symbol radix blocks replace grid-sized BigInt conversion
```

The accepted one-megabyte benchmark improved from 112 seconds on the original codec to 6.15 seconds. The major breakthrough was replacing whole-grid `BigInt` radix conversion with fixed 8-byte/25-symbol blocks. The small density tradeoff increased a one-megabyte fixture from 143 to 145 chunks, but removed the dominant JavaScript preprocessing cost. The exact candidate recovered 145/145 chunks with a matching SHA-256 after Instagram transcoding. The decoder first tries the block format and falls back to the legacy whole-grid conversion, which was verified against a previously generated 143-chunk MP4.

Instagram evidence:

```text
8 MB / three-part carousel: https://www.instagram.com/p/DasuMEijWsG/
realtime VBR / exact 1 MB recovery: https://www.instagram.com/reel/Das4RxOEYP9/
realtime CBR / exact 1 MB recovery: https://www.instagram.com/reel/Das5kvgFqkq/
compact parity header / exact 1 MB recovery: https://www.instagram.com/reel/Das90-XANXH/
fixed-block symbol conversion / exact 1 MB recovery: https://www.instagram.com/reel/DatBXtwG9TR/
fixed-block symbol conversion / exact 8 MB carousel recovery: https://www.instagram.com/p/DatDW5xj6HE/
```

The compact parity-header follow-up encoded a one-megabyte random fixture in 39.2 seconds and survived Instagram with 143/143 chunks plus an exact SHA-256 match. Parity 32 was rejected in a same-machine control (44.5 seconds versus 39.2 seconds for parity 16), so the accepted recovery group remains 16+1.

With fixed-block symbol conversion, an eight-megabyte source encoded into three carousel videos in 29.0 seconds. The local round trip recovered 1,154/1,154 chunks with an exact SHA-256 match. After publishing the exact files as an Instagram carousel, downloading all three CDN-transcoded children, and decoding them together, the reader recovered 517 + 517 + 120 chunks. The reconstructed 8,388,608-byte file matched the source SHA-256 exactly: `a5c7577392284211973f4d1bc1081e023b6e9f9d69c2a79a7d832c2cb1dbcfc3`.

The public upload limit is 28 MiB. At 517 data chunks per video and 7,272 payload bytes per chunk, eight Instagram carousel videos carry 30,076,992 bytes; 28 MiB fits, while 29 MiB requires a ninth video. The interface describes the measured one-megabyte write speed as about 1 MB per 6.15 seconds.

Rejected experiments included 3px cells, two repeats, 3 Mbps, predictive H.264 frames, three-way segment concurrency, four- and eight-color alphabets, and smaller 704px geometry. Each was rejected for Instagram data loss, local data loss, slower measured wall time, or no reliable gain.
