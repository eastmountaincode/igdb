"use client";

import { useEffect, useState, type ChangeEvent, type DragEvent, type FormEvent } from "react";
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
import { encodeCoverVideo } from "@/cover-video";
import {
  MAX_SOURCE_FILE_WITH_COVER_BYTES,
  MAX_SOURCE_FILE_WITH_COVER_LABEL,
  WRITE_SPEED_LABEL
} from "@/upload-limits";

type ActiveTab = "read" | "write";

export function InstagramPixelDbApp() {
  const [activeTab, setActiveTab] = useState<ActiveTab>("write");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [coverMedia, setCoverMedia] = useState<File | null>(null);
  const [coverVideo, setCoverVideo] = useState<Blob | null>(null);
  const [coverVideoUrl, setCoverVideoUrl] = useState("");
  const [isEncodingDisplayVideo, setIsEncodingDisplayVideo] = useState(false);
  const [encodedVideos, setEncodedVideos] = useState<EncodedVideo[]>([]);
  const [decodedChunks, setDecodedChunks] = useState<DecodeResult[]>([]);
  const [decodeMessages, setDecodeMessages] = useState<string[]>([]);
  const [isEncodingVideo, setIsEncodingVideo] = useState(false);
  const [encodeProgress, setEncodeProgress] = useState<EncodeVideoProgress | null>(null);
  const [decodeProgress, setDecodeProgress] = useState<DecodeVideoProgress | null>(null);
  const [isDecodingVideo, setIsDecodingVideo] = useState(false);
  const [readUrl, setReadUrl] = useState("");
  const [isFetchingReadUrl, setIsFetchingReadUrl] = useState(false);
  const [isFileDragActive, setIsFileDragActive] = useState(false);
  const [publishNote, setPublishNote] = useState("");
  const [isPublishing, setIsPublishing] = useState(false);
  const [publishMessage, setPublishMessage] = useState("");
  const [publishedUrl, setPublishedUrl] = useState("");
  const [publishRequestId, setPublishRequestId] = useState("");
  const activeFileLimit = MAX_SOURCE_FILE_WITH_COVER_BYTES;
  const activeFileLimitLabel = MAX_SOURCE_FILE_WITH_COVER_LABEL;
  const fileTooLarge = Boolean(selectedFile && selectedFile.size > activeFileLimit);

  useEffect(() => {
    if (!coverVideo) {
      setCoverVideoUrl("");
      return;
    }
    const url = URL.createObjectURL(coverVideo);
    setCoverVideoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [coverVideo]);

  useEffect(() => {
    let cancelled = false;
    if (!selectedFile) {
      setCoverVideo(null);
      setIsEncodingDisplayVideo(false);
      return;
    }
    setCoverVideo(null);
    setIsEncodingDisplayVideo(true);
    void encodeCoverVideo(coverMedia, {
      name: selectedFile.name,
      type: selectedFile.type || "application/octet-stream",
      size: selectedFile.size
    }).then((video) => {
      if (!cancelled) setCoverVideo(video);
    }).catch((error) => {
      if (!cancelled) setDecodeMessages([`Display video failed: ${error instanceof Error ? error.message : String(error)}`]);
    }).finally(() => {
      if (!cancelled) setIsEncodingDisplayVideo(false);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedFile, coverMedia]);

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
    setCoverVideo(null);
    encodedVideos.forEach((video) => URL.revokeObjectURL(video.url));
    setEncodedVideos([]);
    setPublishMessage("");
    setPublishedUrl("");
    setPublishRequestId(file ? crypto.randomUUID() : "");
  }

  function handleCoverSelection(event: ChangeEvent<HTMLInputElement>) {
    setCoverMedia(event.target.files?.[0] ?? null);
    setCoverVideo(null);
    encodedVideos.forEach((video) => URL.revokeObjectURL(video.url));
    setEncodedVideos([]);
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
      if (videos.length >= 8) {
        throw new Error("This file needs all eight carousel videos. Choose a file 25 MB or smaller so the display video fits first.");
      }
      setEncodedVideos(videos);
      setEncodeProgress({ phase: videos.length > 1 ? "MP4 set ready" : "MP4 ready", completed: videos.length, total: videos.length });
    } catch (error) {
      setDecodeMessages([`Video encode failed: ${error instanceof Error ? error.message : String(error)}`]);
      setEncodeProgress(null);
    } finally {
      setIsEncodingVideo(false);
    }
  }

  async function handleReadUrl(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const url = readUrl.trim();
    if (!url || isFetchingReadUrl || isDecodingVideo) return;
    resetDecode();
    setIsFetchingReadUrl(true);
    setDecodeMessages(["Resolving Instagram URL..."]);
    try {
      const response = await fetch("/api/instagram/read", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ url })
      });
      const result = await readJsonResponse(response);
      if (!response.ok || !result.parts) throw new Error(result.error || "Instagram URL could not be read.");
      const videos: File[] = [];
      for (let part = 0; part < result.parts; part += 1) {
        setDecodeMessages([`Downloading video ${part + 1} of ${result.parts}...`]);
        const videoResponse = await fetch(`/api/instagram/read?url=${encodeURIComponent(url)}&part=${part}`);
        if (!videoResponse.ok) {
          const error = await readJsonResponse(videoResponse);
          throw new Error(error.error || `Video ${part + 1} could not be downloaded.`);
        }
        const blob = await videoResponse.blob();
        videos.push(new File([blob], `instagram-${part + 1}.mp4`, { type: "video/mp4" }));
      }
      await decodeVideoFiles(videos, true);
    } catch (error) {
      setDecodeMessages([error instanceof Error ? error.message : "Instagram URL could not be read."]);
    } finally {
      setIsFetchingReadUrl(false);
    }
  }

  async function decodeVideoFiles(files: File[], downloadWhenComplete = false) {
    const videos = files.filter((file) => file.type.startsWith("video/") || file.name.toLowerCase().endsWith(".mp4"));
    resetDecode();
    if (!videos.length) return;

    setIsDecodingVideo(true);
    const recoveredByIndex = new Map<number, DecodeResult>();
    const messages: string[] = [];
    let mergedChunks: DecodeResult[] = [];
    try {
      for (let index = 0; index < videos.length; index++) {
        const file = videos[index];
        const reportProgress = (progress: DecodeVideoProgress) =>
          setDecodeProgress({
            ...progress,
            phase: videos.length > 1 ? `Video ${index + 1}/${videos.length}: ${progress.phase.toLowerCase()}` : progress.phase
          });
        let chunks: DecodeResult[];
        try {
          chunks = await decodeVideoFile(file, reportProgress);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!message.includes("video metadata")) throw error;
          reportProgress({ phase: "Retrying video load", completed: 0, total: 1 });
          await new Promise((resolve) => window.setTimeout(resolve, 500));
          chunks = await decodeVideoFile(file, reportProgress);
        }
        const recoveredChunks = chunks.filter((chunk) => chunk.ok && chunk.kind === "data");
        for (const chunk of recoveredChunks) {
          if (!recoveredByIndex.has(chunk.chunkIndex)) recoveredByIndex.set(chunk.chunkIndex, chunk);
        }
        mergedChunks = [...recoveredByIndex.values()].sort((left, right) => left.chunkIndex - right.chunkIndex);
        setDecodedChunks(mergedChunks);
        messages.push(
          `${file.name}: recovered ${chunks.length ? `${recoveredChunks.length}/${chunks[0].totalChunks}` : "0"} chunks; merged ${mergedChunks.length}.`
        );
        setDecodeMessages([...messages]);
      }
      setDecodeProgress({ phase: "Decode complete", completed: videos.length, total: videos.length });
      const totalChunks = mergedChunks[0]?.totalChunks ?? 0;
      if (downloadWhenComplete && totalChunks > 0 && mergedChunks.length === totalChunks) {
        const assembled = await reassemble(mergedChunks);
        if (!assembled.hashOk) throw new Error("Recovered file failed SHA-256 verification.");
        downloadBlob(assembled.blob, assembled.fileName);
        setDecodeMessages((current) => [
          ...current,
          `Downloaded ${assembled.fileName}. SHA-256 OK.`
        ]);
      } else if (downloadWhenComplete) {
        throw new Error(`Only ${mergedChunks.length}/${totalChunks || "?"} chunks were recovered.`);
      }
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
    if (!selectedFile || !encodedVideos.length || !coverVideo || isPublishing) return;
    setIsPublishing(true);
    setPublishMessage("Uploading to @normal_shopkeep...");
    setPublishedUrl("");
    try {
      const videos = [...encodedVideos].sort((left, right) => left.segmentIndex - right.segmentIndex);
      const uploadParts = [
        { blob: coverVideo, fileName: "igdb-display-cover.mp4", audioPayload: undefined as Blob | undefined },
        ...videos.map((video) => ({
          blob: video.blob,
          fileName: generatedVideoFileName(selectedFile.name, video.segmentIndex, video.totalSegments),
          audioPayload: video.audioPayload
        }))
      ];
      let uploadId = "";
      let uploadToken = "";
      for (let index = 0; index < uploadParts.length; index += 1) {
        setPublishMessage(`Uploading video ${index + 1} of ${uploadParts.length}...`);
        const video = uploadParts[index];
        const form = new FormData();
        form.set("video", video.blob, video.fileName);
        if (video.audioPayload) {
          form.set("audioPayload", video.audioPayload, `part-${index + 1}.bin`);
        }
        form.set("partIndex", String(index));
        form.set("totalParts", String(uploadParts.length));
        if (index === 0) form.set("displayCover", "true");
        if (uploadId) form.set("uploadId", uploadId);
        if (uploadToken) form.set("uploadToken", uploadToken);
        const uploadResponse = await fetch("/api/instagram/upload", { method: "POST", body: form });
        const uploadResult = await readJsonResponse(uploadResponse);
        if (!uploadResponse.ok || !uploadResult.uploadId || !uploadResult.uploadToken) {
          throw new Error(uploadResult.error || `Video ${index + 1} could not be uploaded.`);
        }
        uploadId = uploadResult.uploadId;
        uploadToken = uploadResult.uploadToken;
      }
      setPublishMessage("Publishing to @normal_shopkeep...");
      const response = await fetch("/api/instagram/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({
          uploadId,
          uploadToken,
          originalName: selectedFile.name,
          originalType: selectedFile.type || "application/octet-stream",
          originalSize: selectedFile.size,
          note: publishNote.trim(),
          confirmation: "publish-to-normal-shopkeep",
          publishRequestId: publishRequestId || crypto.randomUUID()
        })
      });
      const result = await readJsonResponse(response);
      if (!response.ok || (!result.mediaId && !result.permalink)) {
        throw new Error(result.error || "Instagram did not confirm publication.");
      }
      if (result.permalink) setPublishedUrl(result.permalink);
      setPublishMessage(
        result.permalink
          ? `Published ${result.parts ?? uploadParts.length} ${pluralize("video", result.parts ?? uploadParts.length)}.`
          : "Published. Instagram is still preparing the post link."
      );
    } catch (error) {
      setPublishMessage(error instanceof Error ? error.message : "Instagram publishing failed.");
    } finally {
      setIsPublishing(false);
    }
  }

  return (
    <div className="shell">
      <header className="site-header">
        <span className="site-title">Normal Shopkeep</span>
        <nav className="tabbar" aria-label="pages">
          <button
            type="button"
            className={activeTab === "write" ? "active" : ""}
            aria-current={activeTab === "write" ? "page" : undefined}
            onClick={() => setActiveTab("write")}
          >
            Write
          </button>
          <button
            type="button"
            className={activeTab === "read" ? "active" : ""}
            aria-current={activeTab === "read" ? "page" : undefined}
            onClick={() => setActiveTab("read")}
          >
            Read
          </button>
        </nav>
      </header>

      <main>

      {activeTab === "read" ? (
        <section className="tab-panel read-layout">
          <fieldset className="panel read-source">
            <legend>read</legend>
            <form onSubmit={handleReadUrl}>
              <label className="field-label" htmlFor="instagram-read-url">
                Instagram URL
                <input
                  id="instagram-read-url"
                  type="url"
                  inputMode="url"
                  required
                  placeholder="https://www.instagram.com/reel/.../"
                  value={readUrl}
                  onChange={(event) => setReadUrl(event.target.value)}
                />
              </label>
              <div className="button-row">
                <button type="submit" disabled={!readUrl.trim() || isFetchingReadUrl || isDecodingVideo}>
                  {isFetchingReadUrl ? "downloading..." : isDecodingVideo ? "decoding..." : "read URL"}
                </button>
              </div>
            </form>
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
            <p className="file-limit">maximum file size: {activeFileLimitLabel}</p>
            <p className="file-limit">write speed: {WRITE_SPEED_LABEL}</p>
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

            {fileTooLarge ? <p className="file-error" role="alert">file exceeds the {activeFileLimitLabel} maximum</p> : null}

            <div className="button-row">
              <button
                type="button"
                onClick={() => selectedFile && generateVideoForFile(selectedFile)}
                disabled={!selectedFile || fileTooLarge || isEncodingVideo || isEncodingDisplayVideo || !coverVideo}
              >
                {isEncodingVideo ? "encoding..." : isEncodingDisplayVideo ? "preparing preview..." : "generate MP4"}
              </button>
            </div>

            {encodeProgress ? <ProgressView progress={encodeProgress} active={isEncodingVideo} label="Encoding progress" /> : null}

          </fieldset>

          <fieldset className="panel write-output">
            <legend>publish to @normal_shopkeep</legend>
              <div className="field-label">
                <span>carousel cover preview</span>
                {coverVideoUrl ? (
                  <video
                    className="display-video"
                    src={coverVideoUrl}
                    autoPlay
                    loop
                    muted
                    playsInline
                    aria-label="Generated Instagram display video"
                  />
                ) : (
                  <div className="display-video display-video-placeholder" aria-label="Display video not generated">
                    {isEncodingDisplayVideo ? "preparing preview..." : null}
                  </div>
                )}
              </div>
              <label className="field-label" htmlFor="cover-media-input">
                GIF/image (optional)
                <span className="dropzone compact-picker">
                  <input id="cover-media-input" type="file" accept="image/*" onChange={handleCoverSelection} />
                  <span>choose file</span>
                  <strong>{coverMedia?.name ?? "no file selected"}</strong>
                </span>
              </label>
              <label className="field-label" htmlFor="instagram-note">
                caption note (optional)
                <textarea
                  id="instagram-note"
                  value={publishNote}
                  maxLength={1000}
                  onChange={(event) => setPublishNote(event.target.value)}
                  placeholder="add context"
                />
              </label>

              <div className="button-row">
                <button
                  type="button"
                  disabled={!selectedFile || fileTooLarge || !encodedVideos.length || !coverVideo || isPublishing}
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
    </div>
  );
}

async function readJsonResponse(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    if (response.status === 413) throw new Error("A generated video is too large to upload.");
    throw new Error(`The server returned an unexpected response (${response.status}).`);
  }
  return response.json() as Promise<{
    error?: string;
    mediaId?: string;
    permalink?: string;
    parts?: number;
    uploadId?: string;
    uploadToken?: string;
  }>;
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
