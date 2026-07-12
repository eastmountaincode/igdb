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

The intended boundary is:

1. The browser generates an ordered set of MP4 blobs and accepts a user-editable caption.
2. The app uploads the blobs and caption to a server-side job queue on Zo.
3. A single-concurrency worker uses a persistent, dedicated browser profile logged into the chosen Instagram account.
4. The worker posts one video or an ordered multi-video carousel, records status/errors, and cleans up staged files after a retention period.

Do not put Instagram credentials or browser session data in Git. Require a final user action before enqueueing a public post, show the destination account, and make retries idempotent so a failed job cannot create duplicate posts.

The API branch publishes only to `@normal_shopkeep`. It reads `INSTAGRAM_ACCESS_TOKEN_NORMAL_SHOPKEEP` on the server and requires a public HTTPS origin (or `INSTAGRAM_MEDIA_BASE_URL`) so Meta can fetch staged MP4s. The UI builds captions from original file name, MIME type, size, and an optional note.

The published service sources `/root/.zo_secrets` at startup so the Instagram token remains outside the repository. Keep `INSTAGRAM_MEDIA_BASE_URL` pointed at the public Zo Site URL.

## Commands

```bash
npm ci
npm run dev -- -p 5177
npm run build
```
