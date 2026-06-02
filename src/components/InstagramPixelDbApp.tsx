"use client";

import { useEffect, useMemo, useState, type ChangeEvent, type DragEvent, type ReactNode } from "react";
import {
  VIDEO_FPS,
  VIDEO_BITRATE,
  VIDEO_PARITY_GROUP_SIZE,
  VIDEO_REPEAT_FRAMES,
  VIDEO_TARGET_SECONDS,
  capacitySummary,
  decodeVideoFile,
  downloadBlob,
  encodeFileAsVideos,
  estimateVideoPlan,
  formatBytes,
  reassemble,
  type DecodeResult,
  type DecodeVideoProgress,
  type EncodeVideoProgress,
  type EncodedVideo
} from "@/codec";
import { DEFAULT_INSTAGRAM_TEST_URL, type InstagramScrapeResult } from "@/instagram";

type ActiveTab = "read" | "write";
const PARALLEL_INSTAGRAM_PARTS = 2;

export function InstagramPixelDbApp() {
  const [activeTab, setActiveTab] = useState<ActiveTab>("write");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [encodedVideos, setEncodedVideos] = useState<EncodedVideo[]>([]);
  const [decodedChunks, setDecodedChunks] = useState<DecodeResult[]>([]);
  const [caption, setCaption] = useState("");
  const [decodeMessages, setDecodeMessages] = useState<string[]>([]);
  const [instagramUrl, setInstagramUrl] = useState(DEFAULT_INSTAGRAM_TEST_URL);
  const [scrapeResult, setScrapeResult] = useState<InstagramScrapeResult | null>(null);
  const [scrapeStatus, setScrapeStatus] = useState("");
  const [isEncodingVideo, setIsEncodingVideo] = useState(false);
  const [encodeProgress, setEncodeProgress] = useState<EncodeVideoProgress | null>(null);
  const [decodeProgress, setDecodeProgress] = useState<DecodeVideoProgress | null>(null);
  const [isDecodingVideo, setIsDecodingVideo] = useState(false);
  const [isScraping, setIsScraping] = useState(false);
  const [isDecodingScrape, setIsDecodingScrape] = useState(false);
  const [isFileDragActive, setIsFileDragActive] = useState(false);
  const cap = useMemo(() => capacitySummary(), []);
  const selectedPlan = selectedFile ? estimateVideoPlan(selectedFile.size) : null;
  const selectedSegmentCount = selectedPlan?.segments ?? 0;

  const recoveredChunks = decodedChunks.filter((chunk) => chunk.ok && chunk.kind === "data").length;
  const expectedChunks = decodedChunks[0]?.totalChunks ?? 0;
  const canAssemble = expectedChunks > 0 && recoveredChunks === expectedChunks;
  const recoveredFileName = decodedChunks.find((chunk) => chunk.kind === "data" && chunk.fileName)?.fileName;
  const decodeLog = buildDecodeSummary(decodedChunks, decodeMessages);

  function resetDecode() {
    setDecodedChunks([]);
    setDecodeMessages([]);
    setDecodeProgress(null);
  }

  function handleFileSelection(event: ChangeEvent<HTMLInputElement>) {
    selectFile(event.target.files?.[0] ?? null);
  }

  function selectFile(file: File | null) {
    setSelectedFile(file);
  }

  function handleFileDrag(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    if (event.dataTransfer.types.includes("Files")) {
      setIsFileDragActive(true);
    }
  }

  function handleFileDragLeave(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setIsFileDragActive(false);
    }
  }

  function handleFileDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setIsFileDragActive(false);
    selectFile(event.dataTransfer.files?.[0] ?? null);
  }

  async function handleVideoDemoPayload() {
    const payload = buildVideoDemoPayload();
    const file = new File([payload], "fliptable-video-demo.txt", { type: "text/plain" });
    setSelectedFile(file);
    await generateVideoForFile(file);
  }

  async function generateVideoForFile(file: File) {
    resetDecode();
    setIsEncodingVideo(true);
    setEncodeProgress({ phase: "Starting", completed: 0, total: 1 });
    encodedVideos.forEach((video) => URL.revokeObjectURL(video.url));
    setEncodedVideos([]);
    try {
      const videos = await encodeFileAsVideos(file, setEncodeProgress);
      setEncodedVideos(videos);
      setCaption(videos.map((video) => video.caption).join("\n\n---\n\n"));
      setEncodeProgress({ phase: videos.length > 1 ? "MP4 set ready" : "MP4 ready", completed: videos.length, total: videos.length });
    } catch (error) {
      setDecodeMessages([`Video encode failed: ${error instanceof Error ? error.message : String(error)}`]);
      setEncodeProgress(null);
    } finally {
      setIsEncodingVideo(false);
    }
  }

  async function handleDecodeVideoSelection(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    resetDecode();
    if (!file) return;
    await decodeVideo(file);
  }

  async function handleDecodeGeneratedVideo() {
    if (!encodedVideos.length) return;
    resetDecode();
    setIsDecodingVideo(true);
    const recoveredByIndex = new Map<number, DecodeResult>();
    const messages: string[] = [];
    try {
      for (const video of encodedVideos) {
        const file = new File(
          [video.blob],
          generatedVideoFileName(selectedFile?.name, video.segmentIndex, video.totalSegments),
          {
            type: video.blob.type || "video/mp4"
          }
        );
        const chunks = await decodeVideoFile(file, (progress) =>
          setDecodeProgress({
            ...progress,
            phase:
              video.totalSegments > 1
                ? `Segment ${video.segmentIndex + 1}/${video.totalSegments}: ${progress.phase.toLowerCase()}`
                : progress.phase
          })
        );
        for (const chunk of chunks) {
          if (chunk.ok && chunk.kind === "data" && !recoveredByIndex.has(chunk.chunkIndex)) {
            recoveredByIndex.set(chunk.chunkIndex, chunk);
          }
        }
        const recovered = [...recoveredByIndex.values()].sort((left, right) => left.chunkIndex - right.chunkIndex);
        setDecodedChunks(recovered);
        messages.push(
          `segment ${video.segmentIndex + 1}: recovered ${
            chunks.length ? `${chunks.filter((chunk) => chunk.ok && chunk.kind === "data").length}/${chunks[0].totalChunks}` : "0"
          } chunks; merged ${recovered.length}.`
        );
        setDecodeMessages([...messages]);
      }
      setDecodeProgress({ phase: "Decode complete", completed: encodedVideos.length, total: encodedVideos.length });
    } catch (error) {
      setDecodeMessages([...messages, `Generated video decode failed: ${error instanceof Error ? error.message : String(error)}`]);
    } finally {
      setIsDecodingVideo(false);
    }
  }

  async function decodeVideo(file: File) {
    setIsDecodingVideo(true);
    setDecodeProgress({ phase: "Loading video", completed: 0, total: 1 });
    try {
      const chunks = await decodeVideoFile(file, setDecodeProgress);
      setDecodedChunks(chunks);
      setDecodeMessages([
        `Sampled ${file.name}. Recovered ${chunks.length ? `${chunks.length}/${chunks[0].totalChunks}` : "0"} chunks.`
      ]);
      setDecodeProgress({ phase: "Decode complete", completed: 1, total: 1 });
      return chunks;
    } catch (error) {
      setDecodeMessages([`Video decode failed: ${error instanceof Error ? error.message : String(error)}`]);
      return [];
    } finally {
      setIsDecodingVideo(false);
    }
  }

  async function handleAssemble() {
    const assembled = await reassemble(decodedChunks);
    downloadBlob(assembled.blob, assembled.fileName);
    setDecodeMessages((current) => [
      ...current,
      `Reassembled ${assembled.fileName}. SHA-256 ${assembled.hashOk ? "OK" : "MISMATCH"}.`
    ]);
  }

  async function scrapeInstagramSource() {
    setIsScraping(true);
    setScrapeStatus("");
    setScrapeResult(null);
    try {
      const response = await fetch("/api/instagram/scrape", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ url: instagramUrl })
      });
      const body = (await response.json()) as InstagramScrapeResult | { error?: string };
      if (!response.ok) {
        throw new Error("error" in body && body.error ? body.error : `Scrape failed with HTTP ${response.status}.`);
      }
      const result = body as InstagramScrapeResult;
      setScrapeResult(result);
      setScrapeStatus("Scrape complete.");
      return result;
    } catch (error) {
      setScrapeStatus(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      setIsScraping(false);
    }
  }

  async function handleScrape() {
    await scrapeInstagramSource();
  }

  async function handleFetchAndDecodeSource() {
    resetDecode();
    const result = await scrapeInstagramSource();
    if (result?.videos.length) await decodeScrapedVideos(result);
  }

  async function handleDecodeScrapedVideos() {
    if (!scrapeResult?.videos.length) return;
    resetDecode();
    await decodeScrapedVideos(scrapeResult);
  }

  async function decodeScrapedVideos(result: InstagramScrapeResult) {
    if (!result.videos.length) return;

    setIsDecodingScrape(true);
    setDecodeProgress({ phase: "Starting decode", completed: 0, total: result.videos.length });
    const recoveredByIndex = new Map<number, DecodeResult>();
    const messages: string[] = new Array(result.videos.length).fill("");
    const partProgress = result.videos.map<DecodeVideoProgress>(() => ({ phase: "Queued", completed: 0, total: 1 }));
    const publishProgress = () => {
      const total = partProgress.reduce((sum, progress) => sum + Math.max(progress.total, 1), 0);
      const completed = partProgress.reduce((sum, progress) => sum + Math.min(progress.completed, Math.max(progress.total, 1)), 0);
      const active = partProgress
        .map((progress, index) => ({ progress, index }))
        .filter(({ progress }) => progress.completed < progress.total && progress.phase !== "Queued")
        .slice(0, PARALLEL_INSTAGRAM_PARTS)
        .map(({ progress, index }) => `part ${index + 1}: ${progress.phase.toLowerCase()}`)
        .join("; ");
      setDecodeProgress({
        phase: active ? `Decoding ${result.videos.length} parts: ${active}` : "Decoding parts",
        completed,
        total
      });
    };
    const publishMessages = () => setDecodeMessages(messages.filter(Boolean));
    try {
      await mapWithConcurrency(
        result.videos,
        Math.min(PARALLEL_INSTAGRAM_PARTS, result.videos.length),
        async (media, index) => {
          try {
            partProgress[index] = { phase: `Downloading part ${index + 1}`, completed: 0, total: 1 };
            publishProgress();
            const response = await fetch(`/api/instagram/media?url=${encodeURIComponent(media.url)}`);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const blob = await response.blob();
            const chunks = await decodeInstagramPart(blob, index, result.videos.length, (progress) => {
              partProgress[index] = progress;
              publishProgress();
            });
            const recoveredChunks = chunks.filter((chunk) => chunk.ok && chunk.kind === "data");
            for (const chunk of recoveredChunks) {
              if (!recoveredByIndex.has(chunk.chunkIndex)) recoveredByIndex.set(chunk.chunkIndex, chunk);
            }
            const mergedChunks = [...recoveredByIndex.values()].sort((left, right) => left.chunkIndex - right.chunkIndex);
            setDecodedChunks(mergedChunks);
            messages[index] =
              `part ${index + 1}: recovered ${chunks.length ? `${recoveredChunks.length}/${chunks[0].totalChunks}` : "0"} chunks${
                media.width && media.height ? ` from ${media.width}x${media.height}` : ""
              }; merged ${mergedChunks.length}.`;
            partProgress[index] = { phase: `Part ${index + 1} complete`, completed: 1, total: 1 };
            publishProgress();
            publishMessages();
          } catch (error) {
            messages[index] = `part ${index + 1}: ${error instanceof Error ? error.message : String(error)}`;
            partProgress[index] = { phase: `Part ${index + 1} failed`, completed: 1, total: 1 };
            publishProgress();
            publishMessages();
          }
        }
      );
      setDecodeProgress({ phase: "Decode complete", completed: result.videos.length, total: result.videos.length });
    } catch (error) {
      setDecodeMessages([...messages.filter(Boolean), `decode failed: ${error instanceof Error ? error.message : String(error)}`]);
      setDecodeProgress({ phase: "Decode failed", completed: 1, total: 1 });
    } finally {
      setIsDecodingScrape(false);
	    }
	  }

	  async function decodeInstagramPart(
	    blob: Blob,
	    index: number,
	    totalParts: number,
	    onPartProgress: (progress: DecodeVideoProgress) => void
	  ) {
	    let lastError: unknown;
	    for (let attempt = 1; attempt <= 2; attempt++) {
	      try {
	        if (attempt > 1) {
	          onPartProgress({ phase: `Retrying part ${index + 1}/${totalParts}`, completed: 0, total: 1 });
	        }
	        const file = new File([blob], `instagram-part-${String(index + 1).padStart(2, "0")}.mp4`, {
	          type: blob.type || "video/mp4"
	        });
	        return await decodeVideoFile(file, (progress) =>
	          onPartProgress({
	            ...progress,
	            phase: `Part ${index + 1}/${totalParts}: ${progress.phase.toLowerCase()}`
	          })
	        );
	      } catch (error) {
	        lastError = error;
	      }
	    }
	    throw lastError;
	  }

	  return (
    <main className="shell">
      <dl className="stats top-stats">
        <Stat label="Codec">{cap.colors}-color radix</Stat>
        <Stat label="Frame payload">{formatBytes(cap.payloadBytesPerImage)}</Stat>
        <Stat label="Effective rate">{formatBytes(cap.videoBytesPerSecond)} / sec</Stat>
        <Stat label={`${VIDEO_TARGET_SECONDS}s cap`}>{formatBytes(cap.videoTargetBytes)}</Stat>
        <Stat label="Max audio">{formatBytes(cap.videoMaxAudioPayloadBytes)}</Stat>
      </dl>

      <nav className="tabbar" aria-label="Mode">
        <button type="button" className={activeTab === "write" ? "active" : ""} onClick={() => setActiveTab("write")}>
          Write
        </button>
        <button type="button" className={activeTab === "read" ? "active" : ""} onClick={() => setActiveTab("read")}>
          Read
        </button>
      </nav>

      {activeTab === "read" ? (
        <section className="tab-panel read-layout">
          <article className="panel read-source">
            <div className="panel-title">
              <h2>Read from Instagram</h2>
              <p>Paste a post or reel URL. The app resolves the best MP4 for each carousel part, downloads each part, and decodes the file chunks.</p>
            </div>

            <div className="url-row">
              <input
                type="url"
                value={instagramUrl}
                onChange={(event) => setInstagramUrl(event.target.value)}
                placeholder="https://www.instagram.com/p/..."
                aria-label="Instagram URL"
              />
            </div>

            <div className="button-row read-actions">
              <button
                type="button"
                onClick={handleFetchAndDecodeSource}
                disabled={isScraping || isDecodingScrape || isDecodingVideo || !instagramUrl.trim()}
              >
                {isScraping ? "Resolving..." : isDecodingScrape || isDecodingVideo ? "Decoding..." : "Fetch and decode"}
              </button>
            </div>

            <details className="advanced-actions">
              <summary>Advanced</summary>
              <div className="button-row">
                <button type="button" onClick={handleScrape} disabled={isScraping || !instagramUrl.trim()}>
                  {isScraping ? "Resolving..." : "Resolve MP4 parts"}
                </button>
                <button
                  type="button"
                  onClick={handleDecodeScrapedVideos}
                  disabled={isDecodingScrape || isDecodingVideo || !scrapeResult?.videos.length}
                >
                  {isDecodingScrape || isDecodingVideo ? "Decoding..." : "Decode resolved parts"}
                </button>
              </div>
            </details>

            <ScrapeResultView result={scrapeResult} status={scrapeStatus} />
          </article>

          <article className="panel">
            <div className="panel-title">
              <h2>Recovered file</h2>
              <p>Decoded chunks appear here. When all chunks are recovered, download the original file.</p>
            </div>

            <dl className="media-summary">
              <div>
                <dt>Chunks</dt>
                <dd>{expectedChunks ? `${recoveredChunks}/${expectedChunks}` : "None"}</dd>
              </div>
              <div>
                <dt>File</dt>
                <dd>{recoveredFileName ?? "Not decoded"}</dd>
              </div>
            </dl>

            <div className="button-row">
              <button type="button" disabled={!canAssemble} onClick={handleAssemble}>
                Download recovered file
              </button>
            </div>

            {decodeProgress ? (
              <ProgressView progress={decodeProgress} active={isDecodingVideo || isDecodingScrape} label="Decoding progress" />
            ) : null}
            <pre>{decodeLog || "No decoded chunks yet."}</pre>

            <div className="workflow-section">
              <div className="panel-title">
                <h2>Manual video decode</h2>
                <p>Use this for a downloaded MP4 when you already have the file locally.</p>
              </div>
              <label className="dropzone compact" htmlFor="video-decode-input">
                <input id="video-decode-input" type="file" accept="video/*" onChange={handleDecodeVideoSelection} />
                <span>Choose video</span>
                <strong>
                  {expectedChunks ? `${recoveredChunks} / ${expectedChunks} chunks recovered` : "No video decoded"}
                </strong>
              </label>
            </div>
          </article>
        </section>
      ) : (
        <section className="tab-panel write-layout">
          <article className="panel write-source">
            <div className="panel-title">
              <h2>Write a file</h2>
              <p>Choose a local file and generate an Instagram-ready H.264 MP4. Upload the MP4 manually from your Instagram account.</p>
            </div>

            <label
              className={`dropzone${isFileDragActive ? " drag-active" : ""}`}
              htmlFor="file-input"
              onDragEnter={handleFileDrag}
              onDragOver={handleFileDrag}
              onDragLeave={handleFileDragLeave}
              onDrop={handleFileDrop}
            >
              <input id="file-input" type="file" onChange={handleFileSelection} />
              <span>Choose file</span>
                <strong>
                  {selectedFile
                    ? `${selectedFile.name} (${formatBytes(selectedFile.size)}) - ${selectedSegmentCount} ${pluralize(
                        "video",
                        selectedSegmentCount
                      )}, ${selectedPlan?.audioPackets ?? 0} audio ${pluralize("packet", selectedPlan?.audioPackets ?? 0)}`
                    : "No file selected"}
                </strong>
              </label>

            <div className="button-row">
              <button type="button" onClick={handleVideoDemoPayload} disabled={isEncodingVideo}>
                Load demo payload
              </button>
              <button
                type="button"
                onClick={() => selectedFile && generateVideoForFile(selectedFile)}
                disabled={!selectedFile || isEncodingVideo}
              >
                {isEncodingVideo ? "Encoding..." : "Generate MP4"}
              </button>
            </div>

            {encodeProgress ? <ProgressView progress={encodeProgress} active={isEncodingVideo} label="Encoding progress" /> : null}

            <dl className="video-summary">
              <div>
                <dt>Frame rate</dt>
                <dd>{VIDEO_FPS} fps</dd>
              </div>
              <div>
                <dt>Repeat</dt>
                <dd>{VIDEO_REPEAT_FRAMES} frames</dd>
              </div>
              <div>
                <dt>Parity</dt>
                <dd>{VIDEO_PARITY_GROUP_SIZE}+1 XOR</dd>
              </div>
              <div>
                <dt>Planned audio</dt>
                <dd>{selectedPlan ? `${formatBytes(selectedPlan.audioPayloadBytes)} (${selectedPlan.audioPackets} packets)` : "Select a file"}</dd>
              </div>
              <div>
                <dt>Bitrate</dt>
                <dd>{Math.round(VIDEO_BITRATE / 1_000_000)} Mbps</dd>
              </div>
            </dl>
          </article>

          <article className="panel write-output">
            <div className="panel-title">
              <h2>Generated videos</h2>
              <p>Upload all generated MP4 segments in order. The caption manifest is optional, but useful for demo notes and debugging.</p>
            </div>

            {encodedVideos.length ? (
              <div className="video-list">
	                <div className="button-row">
	                  <button type="button" onClick={handleDecodeGeneratedVideo} disabled={isDecodingVideo}>
	                    {encodedVideos.length > 1 ? "Verify all" : "Verify decode"}
	                  </button>
	                  {encodedVideos.length > 1 ? (
	                    <button
	                      type="button"
	                      onClick={() =>
	                        encodedVideos.forEach((video) =>
	                          downloadBlob(video.blob, generatedVideoFileName(selectedFile?.name, video.segmentIndex, video.totalSegments))
	                        )
	                      }
	                    >
	                      Download all MP4s
	                    </button>
	                  ) : null}
	                </div>
	                {encodedVideos.map((video) => (
	                  <div className="video-output" key={video.url}>
	                    <video src={video.url} controls muted playsInline />
	                    <div className="video-output-footer">
	                      <div className="video-meta">
	                        <strong>
	                          Part {video.segmentIndex + 1} of {video.totalSegments}
	                        </strong>
	                        <span>{formatBytes(video.payloadBytes)} payload</span>
	                        <span>
	                          data chunks {video.dataChunkStart + 1}-{video.dataChunkEnd + 1}, {video.chunkCount} transmitted chunks,{" "}
	                          {video.durationSeconds.toFixed(1)} seconds
	                        </span>
	                        {video.audioPacketCount ? (
	                          <span>
	                            audio {formatBytes(video.audioPayloadBytes ?? 0)}, {video.audioPacketCount} packets
	                          </span>
	                        ) : null}
	                      </div>
	                      <button
	                        type="button"
	                        onClick={() => downloadBlob(video.blob, generatedVideoFileName(selectedFile?.name, video.segmentIndex, video.totalSegments))}
	                      >
	                        {encodedVideos.length > 1 ? `Download part ${video.segmentIndex + 1}` : "Download MP4"}
	                      </button>
	                    </div>
	                  </div>
	                ))}
              </div>
            ) : (
              <div className="empty-output">No MP4 generated yet.</div>
            )}

            <textarea readOnly value={caption} placeholder="Video caption manifest will appear here." />
          </article>
        </section>
      )}
    </main>
  );
}

function ScrapeResultView({
  result,
  status
}: {
  result: InstagramScrapeResult | null;
  status: string;
}) {
  if (!result && !status) return null;

  return (
    <div className="scrape-result">
      {status ? <strong>{status}</strong> : null}
      {result ? (
        <>
          <dl className="media-summary">
            <div>
              <dt>MP4 parts</dt>
              <dd>{result.videos.length}</dd>
            </div>
            <div>
              <dt>Images ignored</dt>
              <dd>{result.images.length}</dd>
            </div>
          </dl>
          {result.captionText ? <p className="caption-preview">{result.captionText}</p> : null}
          {result.warnings.length ? (
            <ul className="warnings">
              {result.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}
          <ol className="media-list">
            {result.videos.slice(0, 12).map((media) => (
              <li key={media.url}>
                <span>
                  {media.width && media.height ? `${media.width}x${media.height}` : media.kind}
                  {media.source ? ` ${media.source}` : ""}
                </span>
                <a href={media.url} target="_blank" rel="noreferrer">
                  {media.url}
                </a>
              </li>
            ))}
          </ol>
        </>
      ) : null}
    </div>
  );
}

function ProgressView({
  progress,
  active,
  label
}: {
  progress: EncodeVideoProgress | DecodeVideoProgress;
  active: boolean;
  label: string;
}) {
  const [phaseStartedAt, setPhaseStartedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const percent = progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0;
  const clampedPercent = Math.max(0, Math.min(100, percent));
  const elapsedMs = Math.max(0, now - phaseStartedAt);
  const hasEta = active && progress.completed > 0 && progress.completed < progress.total;
  const etaMs = hasEta ? (elapsedMs / progress.completed) * (progress.total - progress.completed) : 0;

  useEffect(() => {
    if (!active) {
      setNow(Date.now());
      return;
    }

    const nextStartedAt = Date.now();
    setPhaseStartedAt(nextStartedAt);
    setNow(nextStartedAt);
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [active]);

  return (
    <div
      className="encode-progress"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={clampedPercent}
    >
      <div className="progress-row">
        <strong>{progress.phase}</strong>
        <span>{active ? `${clampedPercent}%` : "Done"}</span>
      </div>
      <div className="progress-meter">
        <div style={{ width: `${clampedPercent}%` }} />
      </div>
      <span className="progress-detail">
        {progress.completed} / {progress.total} | Elapsed {formatDuration(elapsedMs)}
        {active ? ` | ETA ${hasEta ? formatDuration(etaMs) : "estimating"}` : ""}
      </span>
    </div>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>
) {
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        await fn(items[index], index);
      }
    })
  );
}

function buildVideoDemoPayload() {
  const header = [
    "FLIPTABLE Instagram Pixel DB video payload",
    "This larger file is encoded across time as repeated color-grid video frames.",
    ""
  ].join("\n");
  const rows: string[] = [];
  for (let i = 0; i < 7500; i++) {
    rows.push(
      JSON.stringify({
        row: i,
        frameGroup: Math.floor(i / 48),
        file: "fliptable-video-demo.txt",
        phrase: "instagram video as public filesystem",
        checksumSeed: (i * 2246822519) >>> 0
      })
    );
  }
  return `${header}${rows.join("\n")}\n`;
}

function generatedVideoFileName(sourceName?: string, segmentIndex = 0, totalSegments = 1) {
  const baseName = sourceName?.trim() ? sourceName.replace(/\.[^.]+$/, "") : "payload";
  const safeName = baseName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  const segmentSuffix = totalSegments > 1
    ? `-part-${String(segmentIndex + 1).padStart(2, "0")}-of-${String(totalSegments).padStart(2, "0")}`
    : "";
  return `igdb-video-${safeName || "payload"}${segmentSuffix}.mp4`;
}

function buildDecodeSummary(chunks: DecodeResult[], messages: string[]) {
  if (!chunks.length) return messages.join("\n");

  const dataChunks = chunks.filter((chunk) => chunk.ok && chunk.kind === "data").sort((left, right) => left.chunkIndex - right.chunkIndex);
  const totalChunks = dataChunks[0]?.totalChunks ?? 0;
  const fileName = dataChunks.find((chunk) => chunk.fileName)?.fileName ?? "unknown file";
  const recoveredIndexes = new Set(dataChunks.map((chunk) => chunk.chunkIndex));
  const missingIndexes =
    totalChunks > 0
      ? Array.from({ length: totalChunks }, (_, index) => index).filter((index) => !recoveredIndexes.has(index))
      : [];

  return [
    `Recovered ${dataChunks.length}/${totalChunks || "?"} data chunks for ${fileName}.`,
    missingIndexes.length ? `Missing ${missingIndexes.length}: ${formatIndexRanges(missingIndexes, 12)}.` : "All data chunks recovered.",
    ...messages
  ]
    .filter(Boolean)
    .join("\n");
}

function formatIndexRanges(indexes: number[], maxRanges: number) {
  const ranges: string[] = [];
  let start = indexes[0];
  let previous = indexes[0];

  for (let i = 1; i <= indexes.length; i++) {
    const value = indexes[i];
    if (value === previous + 1) {
      previous = value;
      continue;
    }

    ranges.push(start === previous ? String(start + 1) : `${start + 1}-${previous + 1}`);
    start = value;
    previous = value;
    if (ranges.length >= maxRanges && i < indexes.length) {
      ranges.push(`...${indexes.length - i} more`);
      break;
    }
  }

  return ranges.join(", ");
}

function pluralize(word: string, count: number) {
  return count === 1 ? word : `${word}s`;
}

function formatDuration(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}:${String(seconds).padStart(2, "0")}`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}:${String(remainingMinutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
