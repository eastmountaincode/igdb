"use client";

import { useEffect, useMemo, useState, type ChangeEvent, type DragEvent } from "react";
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
import { buildInstagramCaption } from "@/instagram-caption";

type ActiveTab = "read" | "write";

export function InstagramPixelDbApp() {
  const [activeTab, setActiveTab] = useState<ActiveTab>("write");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [encodedVideos, setEncodedVideos] = useState<EncodedVideo[]>([]);
  const [decodedChunks, setDecodedChunks] = useState<DecodeResult[]>([]);
  const [caption, setCaption] = useState("");
  const [decodeMessages, setDecodeMessages] = useState<string[]>([]);
  const [isEncodingVideo, setIsEncodingVideo] = useState(false);
  const [encodeProgress, setEncodeProgress] = useState<EncodeVideoProgress | null>(null);
  const [decodeProgress, setDecodeProgress] = useState<DecodeVideoProgress | null>(null);
  const [isDecodingVideo, setIsDecodingVideo] = useState(false);
  const [isFileDragActive, setIsFileDragActive] = useState(false);
  const [isVideoDragActive, setIsVideoDragActive] = useState(false);
  const [publishNote, setPublishNote] = useState("");
  const [publishConfirmed, setPublishConfirmed] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [publishMessage, setPublishMessage] = useState("");
  const [publishedUrl, setPublishedUrl] = useState("");
  const cap = useMemo(() => capacitySummary(), []);
  const selectedPlan = selectedFile ? estimateVideoPlan(selectedFile.size) : null;
  const selectedSegmentCount = selectedPlan?.segments ?? 0;

  const recoveredChunks = decodedChunks.filter((chunk) => chunk.ok && chunk.kind === "data").length;
  const expectedChunks = decodedChunks[0]?.totalChunks ?? 0;
  const canAssemble = expectedChunks > 0 && recoveredChunks === expectedChunks;
  const recoveredFileName = decodedChunks.find((chunk) => chunk.kind === "data" && chunk.fileName)?.fileName;
  const decodeLog = buildDecodeSummary(decodedChunks, decodeMessages);
  const publishingCaption = selectedFile
    ? buildInstagramCaption({
        name: selectedFile.name,
        type: selectedFile.type || "application/octet-stream",
        size: selectedFile.size,
        note: publishNote
      })
    : "Select and encode a file to prepare its Instagram caption.";

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
    setPublishConfirmed(false);
    setPublishMessage("");
    setPublishedUrl("");
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
    await decodeVideoFiles([...(event.target.files ?? [])]);
  }

  function handleVideoDrag(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    if (event.dataTransfer.types.includes("Files")) {
      setIsVideoDragActive(true);
    }
  }

  function handleVideoDragLeave(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setIsVideoDragActive(false);
    }
  }

  async function handleVideoDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setIsVideoDragActive(false);
    await decodeVideoFiles([...event.dataTransfer.files]);
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

  async function decodeVideoFiles(files: File[]) {
    const videos = files.filter((file) => file.type.startsWith("video/") || file.name.toLowerCase().endsWith(".mp4"));
    resetDecode();
    if (!videos.length) return;

    setIsDecodingVideo(true);
    const recoveredByIndex = new Map<number, DecodeResult>();
    const messages: string[] = [];
    try {
      for (let index = 0; index < videos.length; index++) {
        const file = videos[index];
        const chunks = await decodeVideoFile(file, (progress) =>
          setDecodeProgress({
            ...progress,
            phase: videos.length > 1 ? `Video ${index + 1}/${videos.length}: ${progress.phase.toLowerCase()}` : progress.phase
          })
        );
        const recoveredChunks = chunks.filter((chunk) => chunk.ok && chunk.kind === "data");
        for (const chunk of recoveredChunks) {
          if (!recoveredByIndex.has(chunk.chunkIndex)) recoveredByIndex.set(chunk.chunkIndex, chunk);
        }
        const mergedChunks = [...recoveredByIndex.values()].sort((left, right) => left.chunkIndex - right.chunkIndex);
        setDecodedChunks(mergedChunks);
        messages.push(
          `${file.name}: recovered ${chunks.length ? `${recoveredChunks.length}/${chunks[0].totalChunks}` : "0"} chunks; merged ${mergedChunks.length}.`
        );
        setDecodeMessages([...messages]);
      }
      setDecodeProgress({ phase: "Decode complete", completed: videos.length, total: videos.length });
    } catch (error) {
      setDecodeMessages([...messages, `Video decode failed: ${error instanceof Error ? error.message : String(error)}`]);
      setDecodeProgress({ phase: "Decode failed", completed: 1, total: 1 });
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

  async function handlePublishToInstagram() {
    if (!selectedFile || !encodedVideos.length || !publishConfirmed || isPublishing) return;
    setIsPublishing(true);
    setPublishMessage("Uploading to @normal_shopkeep...");
    setPublishedUrl("");
    try {
      const form = new FormData();
      for (const video of [...encodedVideos].sort((left, right) => left.segmentIndex - right.segmentIndex)) {
        form.append(
          "videos",
          video.blob,
          generatedVideoFileName(selectedFile.name, video.segmentIndex, video.totalSegments)
        );
      }
      form.set("originalName", selectedFile.name);
      form.set("originalType", selectedFile.type || "application/octet-stream");
      form.set("originalSize", String(selectedFile.size));
      form.set("note", publishNote.trim());
      form.set("confirmation", "publish-to-normal-shopkeep");

      const response = await fetch("/api/instagram/publish", { method: "POST", body: form });
      const result = (await response.json()) as { error?: string; permalink?: string; parts?: number };
      if (!response.ok || !result.permalink) throw new Error(result.error || "Instagram did not return a post URL.");
      setPublishedUrl(result.permalink);
      setPublishMessage(`Published ${result.parts ?? encodedVideos.length} ${pluralize("video", result.parts ?? encodedVideos.length)}.`);
      setPublishConfirmed(false);
    } catch (error) {
      setPublishMessage(error instanceof Error ? error.message : "Instagram publishing failed.");
    } finally {
      setIsPublishing(false);
    }
  }

  return (
    <main className="shell">
      <div className="spec-strip" aria-label="Codec settings">
        <span><b>{cap.colors}-color radix</b></span>
        <span>{formatBytes(cap.payloadBytesPerImage)}/frame</span>
        <span>{formatBytes(cap.videoBytesPerSecond)}/s</span>
        <span>{VIDEO_TARGET_SECONDS}s cap: {formatBytes(cap.videoTargetBytes)}</span>
        <span>audio max {formatBytes(cap.videoMaxAudioPayloadBytes)}</span>
      </div>

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
              <h2>Read video</h2>
            </div>

            <label
              className={`dropzone video-dropzone${isVideoDragActive ? " drag-active" : ""}`}
              htmlFor="video-decode-input"
              onDragEnter={handleVideoDrag}
              onDragOver={handleVideoDrag}
              onDragLeave={handleVideoDragLeave}
              onDrop={handleVideoDrop}
            >
              <input id="video-decode-input" type="file" accept="video/*,.mp4" multiple onChange={handleDecodeVideoSelection} />
              <span>Choose MP4</span>
              <strong>{expectedChunks ? `${recoveredChunks} / ${expectedChunks} chunks recovered` : "No video decoded"}</strong>
            </label>
          </article>

          <article className="panel">
            <div className="panel-title">
              <h2>Recovered file</h2>
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

            {decodeProgress ? <ProgressView progress={decodeProgress} active={isDecodingVideo} label="Decoding progress" /> : null}
            <pre>{decodeLog || "No decoded chunks yet."}</pre>
          </article>
        </section>
      ) : (
        <section className="tab-panel write-layout">
          <article className="panel write-source">
            <div className="panel-title">
              <h2>Write a file</h2>
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
              <button
                type="button"
                onClick={() => selectedFile && generateVideoForFile(selectedFile)}
                disabled={!selectedFile || isEncodingVideo}
              >
                {isEncodingVideo ? "Encoding..." : "Generate MP4"}
              </button>
            </div>

            {encodeProgress ? <ProgressView progress={encodeProgress} active={isEncodingVideo} label="Encoding progress" /> : null}

            <dl className="video-summary compact-summary">
              <div>
                <dt>FPS</dt>
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
                <dt>Audio</dt>
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

            <section className="publish-card" aria-labelledby="instagram-publish-title">
              <div className="panel-title">
                <h2 id="instagram-publish-title">Publish to @normal_shopkeep</h2>
                <p>Generated videos are posted in part order as one Reel or carousel.</p>
              </div>

              <label className="field-label" htmlFor="instagram-note">
                Optional note
                <textarea
                  id="instagram-note"
                  value={publishNote}
                  maxLength={1000}
                  onChange={(event) => {
                    setPublishNote(event.target.value);
                    setPublishConfirmed(false);
                  }}
                  placeholder="Add context for this file."
                />
              </label>

              <div className="caption-preview">
                <strong>Caption preview</strong>
                <pre>{publishingCaption}</pre>
              </div>

              <label className="publish-confirmation">
                <input
                  type="checkbox"
                  checked={publishConfirmed}
                  disabled={!encodedVideos.length || isPublishing}
                  onChange={(event) => setPublishConfirmed(event.target.checked)}
                />
                Publish these {encodedVideos.length || 0} {pluralize("video", encodedVideos.length || 0)} publicly to @normal_shopkeep.
              </label>

              <div className="button-row">
                <button
                  type="button"
                  disabled={!selectedFile || !encodedVideos.length || !publishConfirmed || isPublishing}
                  onClick={handlePublishToInstagram}
                >
                  {isPublishing ? "Publishing..." : "Publish to Instagram"}
                </button>
              </div>

              {publishMessage ? <p className="publish-status" role="status">{publishMessage}</p> : null}
              {publishedUrl ? <a className="published-link" href={publishedUrl} target="_blank" rel="noreferrer">Open Instagram post</a> : null}
            </section>
          </article>
        </section>
      )}
    </main>
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
