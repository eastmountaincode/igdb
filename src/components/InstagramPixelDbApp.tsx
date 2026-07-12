"use client";

import { useEffect, useState, type ChangeEvent, type DragEvent } from "react";
import {
  decodeVideoFile,
  downloadBlob,
  encodeFileAsVideos,
  formatBytes,
  reassemble,
  type DecodeResult,
  type DecodeVideoProgress,
  type EncodeVideoProgress,
  type EncodedVideo
} from "@/codec";
import { buildInstagramCaption } from "@/instagram-caption";
import { MAX_SOURCE_FILE_BYTES, MAX_SOURCE_FILE_LABEL } from "@/upload-limits";

type ActiveTab = "read" | "write";

export function InstagramPixelDbApp() {
  const [activeTab, setActiveTab] = useState<ActiveTab>("write");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [encodedVideos, setEncodedVideos] = useState<EncodedVideo[]>([]);
  const [decodedChunks, setDecodedChunks] = useState<DecodeResult[]>([]);
  const [decodeMessages, setDecodeMessages] = useState<string[]>([]);
  const [isEncodingVideo, setIsEncodingVideo] = useState(false);
  const [encodeProgress, setEncodeProgress] = useState<EncodeVideoProgress | null>(null);
  const [decodeProgress, setDecodeProgress] = useState<DecodeVideoProgress | null>(null);
  const [isDecodingVideo, setIsDecodingVideo] = useState(false);
  const [isFileDragActive, setIsFileDragActive] = useState(false);
  const [isVideoDragActive, setIsVideoDragActive] = useState(false);
  const [publishNote, setPublishNote] = useState("");
  const [isPublishing, setIsPublishing] = useState(false);
  const [publishMessage, setPublishMessage] = useState("");
  const [publishedUrl, setPublishedUrl] = useState("");
  const fileTooLarge = Boolean(selectedFile && selectedFile.size > MAX_SOURCE_FILE_BYTES);
  const captionPreview = selectedFile
    ? buildInstagramCaption({
        name: selectedFile.name,
        type: selectedFile.type || "application/octet-stream",
        size: selectedFile.size,
        note: publishNote
      })
    : "";

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
    if (!selectedFile || !encodedVideos.length || isPublishing) return;
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
    } catch (error) {
      setPublishMessage(error instanceof Error ? error.message : "Instagram publishing failed.");
    } finally {
      setIsPublishing(false);
    }
  }

  return (
    <main className="shell">
      <nav className="tabbar" aria-label="Mode">
        <button type="button" className={activeTab === "write" ? "active" : ""} onClick={() => setActiveTab("write")}>
          write
        </button>
        <button type="button" className={activeTab === "read" ? "active" : ""} onClick={() => setActiveTab("read")}>
          read
        </button>
      </nav>

      {activeTab === "read" ? (
        <section className="tab-panel read-layout">
          <fieldset className="panel read-source">
            <legend>read video</legend>
            <label
              className={`dropzone video-dropzone${isVideoDragActive ? " drag-active" : ""}`}
              htmlFor="video-decode-input"
              onDragEnter={handleVideoDrag}
              onDragOver={handleVideoDrag}
              onDragLeave={handleVideoDragLeave}
              onDrop={handleVideoDrop}
            >
              <input id="video-decode-input" type="file" accept="video/*,.mp4" multiple onChange={handleDecodeVideoSelection} />
              <span>choose MP4</span>
              <strong>{expectedChunks ? `${recoveredChunks} / ${expectedChunks} chunks recovered` : "no video selected"}</strong>
            </label>
          </fieldset>

          <fieldset className="panel">
            <legend>recovered file</legend>
            <dl className="media-summary">
              <div>
                <dt>chunks</dt>
                <dd>{expectedChunks ? `${recoveredChunks}/${expectedChunks}` : "—"}</dd>
              </div>
              <div>
                <dt>file</dt>
                <dd>{recoveredFileName ?? "—"}</dd>
              </div>
            </dl>

            <div className="button-row">
              <button type="button" disabled={!canAssemble} onClick={handleAssemble}>
                download recovered file
              </button>
            </div>

            {decodeProgress ? <ProgressView progress={decodeProgress} active={isDecodingVideo} label="Decoding progress" /> : null}
            {decodeLog ? <pre>{decodeLog}</pre> : null}
          </fieldset>
        </section>
      ) : (
        <section className="tab-panel write-layout">
          <fieldset className="panel write-source">
            <legend>write</legend>
            <p className="file-limit">maximum file size: {MAX_SOURCE_FILE_LABEL}</p>
            <label
              className={`dropzone${isFileDragActive ? " drag-active" : ""}`}
              htmlFor="file-input"
              onDragEnter={handleFileDrag}
              onDragOver={handleFileDrag}
              onDragLeave={handleFileDragLeave}
              onDrop={handleFileDrop}
            >
              <input id="file-input" type="file" onChange={handleFileSelection} />
              <span>choose file</span>
                <strong>
                  {selectedFile
                    ? `${selectedFile.name} (${formatBytes(selectedFile.size)})`
                    : "no file selected"}
                </strong>
              </label>

            {fileTooLarge ? <p className="file-error" role="alert">file exceeds the {MAX_SOURCE_FILE_LABEL} maximum</p> : null}

            <div className="button-row">
              <button
                type="button"
                onClick={() => selectedFile && generateVideoForFile(selectedFile)}
                disabled={!selectedFile || fileTooLarge || isEncodingVideo}
              >
                {isEncodingVideo ? "encoding..." : "generate MP4"}
              </button>
            </div>

            {encodeProgress ? <ProgressView progress={encodeProgress} active={isEncodingVideo} label="Encoding progress" /> : null}

          </fieldset>

          <fieldset className="panel write-output">
            <legend>publish to @normal_shopkeep</legend>
              <label className="field-label" htmlFor="instagram-note">
                optional note
                <textarea
                  id="instagram-note"
                  value={publishNote}
                  maxLength={1000}
                  onChange={(event) => setPublishNote(event.target.value)}
                  placeholder="add context"
                />
              </label>

              <label className="field-label" htmlFor="instagram-caption-preview">
                caption
                <textarea id="instagram-caption-preview" readOnly value={captionPreview} placeholder="choose a file" />
              </label>

              <div className="button-row">
                <button
                  type="button"
                  disabled={!selectedFile || fileTooLarge || !encodedVideos.length || isPublishing}
                  onClick={handlePublishToInstagram}
                >
                  {isPublishing ? "publishing..." : "publish to Instagram"}
                </button>
              </div>

              {publishMessage ? <p className="publish-status" role="status">{publishMessage}</p> : null}
              {publishedUrl ? <a className="published-link" href={publishedUrl} target="_blank" rel="noreferrer">open Instagram post</a> : null}
          </fieldset>
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
