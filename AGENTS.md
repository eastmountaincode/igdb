# IGDB project guide

## Purpose

IGDB encodes a file into one or more Instagram-compatible H.264 MP4 videos and can recover the original file from those videos. Encoding and decoding currently happen entirely in the browser.

## Current architecture

- `src/components/InstagramPixelDbApp.tsx`: write/read UI and generated-video state.
- `src/codec.ts`: file splitting, MP4 encoding, captions, decoding, and reassembly.
- `src/codec-worker.ts` and `src/codec-decode-worker.ts`: browser codec workers.
- `src/audio-codec.ts`: AAC/DTMF side channel.
- Generated MP4s are `Blob` objects held only in browser memory until downloaded.
- `zosite.json`: Zo development configuration on port 5177.
- Public Zo Site: `https://igdb-instagram-eastmountain.zocomputer.io` (service port 5178).

## Instagram upload experiment

Branches:

- `experiment/instagram-auto-upload`: browser-automation research.
- `feature/instagram-api-upload`: Meta Instagram API publishing integration.
- `experiment/encode-performance`: iterative encoding-speed and payload-capacity research; preserve byte-perfect recovery and publishing behavior while benchmarking each codec change.

The accepted performance profile is 720px, 4px cells, six colors, three repeats, compact XOR parity 16+1 headers, 6 Mbps H.264 with constant bitrate and realtime latency mode, and two-way segment concurrency. Symbol conversion uses independent 8-byte/25-symbol radix blocks rather than one grid-sized `BigInt`; this is the primary encoding-speed optimization. Browsers without CBR support fall back to the separately Instagram-verified realtime VBR mode. Each video also reserves up to five independently synchronized 16-byte DTMF packets. The browser sends their raw payload beside the silent MP4, and the Zo publisher generates mono PCM, encodes it as AAC with ffmpeg, and muxes it before Meta fetches the staged video. The robust DTMF alphabet uses four tone pairs and base-4 symbols because the full 16-tone alphabet did not preserve arbitrary bytes through AAC. Decoding remains backward-compatible with both the older whole-grid symbol conversion and array-based parity headers. Do not weaken it based on local decoding alone; every codec change must survive an Instagram publish/download round trip and final SHA-256 verification.

The intended boundary is:

1. The browser generates an ordered set of MP4 blobs and accepts a user-editable caption.
2. The app uploads the blobs and caption to a server-side job queue on Zo.
3. A single-concurrency worker uses a persistent, dedicated browser profile logged into the chosen Instagram account.
4. The worker posts one video or an ordered multi-video carousel, records status/errors, and cleans up staged files after a retention period.

Do not put Instagram credentials or browser session data in Git. Require a final user action before enqueueing a public post, show the destination account, and make retries idempotent so a failed job cannot create duplicate posts.

The API branch publishes only to `@normal_shopkeep`. It reads `INSTAGRAM_ACCESS_TOKEN_NORMAL_SHOPKEEP` on the server and requires a public HTTPS origin (or `INSTAGRAM_MEDIA_BASE_URL`) so Meta can fetch staged MP4s. The UI builds captions from original file name, MIME type, size, and an optional note.

The Read page accepts an Instagram post or Reel URL from `@normal_shopkeep`. Zo resolves and proxies its ordered video parts through the authorized Instagram API, the existing browser decoder reconstructs and SHA-256 verifies the source, and the recovered file downloads directly. Never expose Instagram CDN URLs or the account token to the browser.

Every Write creates an eight-second, 720×720 H.264 **display video** containing the source filename, MIME type, and size. It is always carousel item 1 before the encoded data videos. An optional animated GIF may appear inside its padded safe area. The UI previews the actual generated MP4, not a responsive HTML imitation. The source limit is 25 MB so seven data videos plus the display video stay within Instagram's eight-item limit. Published media IDs and their display-video flag are recorded in the runtime-only `.instagram-media-index.json`, allowing Read to omit item 1 before decoding.

The published service sources `/root/.zo_secrets` at startup so the Instagram token remains outside the repository. Keep `INSTAGRAM_MEDIA_BASE_URL` pointed at the public Zo Site URL.

## Commands

```bash
npm ci
npm run dev -- -p 5177
npm run build
```
