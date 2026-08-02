"use client";

import { useEffect, useState, type ChangeEvent, type DragEvent, type FormEvent } from "react";
import {
  decodeVideoFile,
  encodeFileAsVideos,
  formatBytes,
  recoverDataChunks,
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

type ActiveTab = "about" | "read" | "share" | "write";
type PublishPartStatus = {
  label: string;
  status: "waiting" | "uploading" | "processing" | "ready" | "failed";
};
type ReadPartStatus = {
  label: string;
  status: "waiting" | "downloading" | "downloaded" | "decoding" | "decoded" | "failed";
};

export function InstagramPixelDbApp() {
  const [activeTab, setActiveTab] = useState<ActiveTab>("write");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fileSelectionMessage, setFileSelectionMessage] = useState("");
  const [coverMedia, setCoverMedia] = useState<File | null>(null);
  const [coverVideo, setCoverVideo] = useState<Blob | null>(null);
  const [coverVideoUrl, setCoverVideoUrl] = useState("");
  const [isEncodingDisplayVideo, setIsEncodingDisplayVideo] = useState(false);
  const [encodedVideos, setEncodedVideos] = useState<EncodedVideo[]>([]);
  const [decodedChunks, setDecodedChunks] = useState<DecodeResult[]>([]);
  const [recoveredFile, setRecoveredFile] = useState<{ blob: Blob; fileName: string } | null>(null);
  const [hasDownloadedRecoveredFile, setHasDownloadedRecoveredFile] = useState(false);
  const [isPreparingRecoveredDownload, setIsPreparingRecoveredDownload] = useState(false);
  const [decodeMessages, setDecodeMessages] = useState<string[]>([]);
  const [isEncodingVideo, setIsEncodingVideo] = useState(false);
  const [encodeError, setEncodeError] = useState("");
  const [encodeProgress, setEncodeProgress] = useState<EncodeVideoProgress | null>(null);
  const [decodeProgress, setDecodeProgress] = useState<DecodeVideoProgress | null>(null);
  const [readParts, setReadParts] = useState<ReadPartStatus[]>([]);
  const [verificationStatus, setVerificationStatus] = useState<"waiting" | "verifying" | "ready" | "failed" | "">("");
  const [isDecodingVideo, setIsDecodingVideo] = useState(false);
  const [readUrl, setReadUrl] = useState("");
  const [shareInstagramUrl, setShareInstagramUrl] = useState("");
  const [fileShareLink, setFileShareLink] = useState("");
  const [copiedShareLink, setCopiedShareLink] = useState("");
  const [isFetchingReadUrl, setIsFetchingReadUrl] = useState(false);
  const [isFileDragActive, setIsFileDragActive] = useState(false);
  const [addedBy, setAddedBy] = useState("");
  const [publishNote, setPublishNote] = useState("");
  const [isPublishing, setIsPublishing] = useState(false);
  const [publishMessage, setPublishMessage] = useState("");
  const [publishedUrl, setPublishedUrl] = useState("");
  const [publishRequestId, setPublishRequestId] = useState("");
  const [publishParts, setPublishParts] = useState<PublishPartStatus[]>([]);
  const [publishQueuePosition, setPublishQueuePosition] = useState<number | null>(null);
  const activeFileLimit = MAX_SOURCE_FILE_WITH_COVER_BYTES;
  const activeFileLimitLabel = MAX_SOURCE_FILE_WITH_COVER_LABEL;
  const fileTooLarge = Boolean(selectedFile && selectedFile.size > activeFileLimit);
  const normalizedReadUrl = normalizeReadUrl(readUrl);
  const publishSucceeded = publishMessage.startsWith("Published");
  const nextWriteStep = isEncodingVideo || isEncodingDisplayVideo || isPublishing || publishSucceeded
    ? null
    : !selectedFile || fileTooLarge
      ? "choose-file"
      : encodedVideos.length === 0
        ? "generate-mp4"
        : "publish-instagram";

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const shareId = params.get("share");
    if (shareId && isValidShareId(shareId)) {
      setActiveTab("read");
      setDecodeMessages(["Resolving file share link..."]);
      void resolvePermanentShareLink(shareId).then((instagramUrl) => {
        setReadUrl(instagramUrl);
        setDecodeMessages([]);
      }).catch((error) => {
        setDecodeMessages([error instanceof Error ? error.message : "File share link could not be resolved."]);
      });
      return;
    }
    const sharedUrl = params.get("read");
    const normalized = normalizeReadUrl(sharedUrl ?? "");
    if (!normalized) return;
    setReadUrl(normalized);
    setActiveTab("read");
  }, []);

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
  const recoveredCodec = decodedChunks.find((chunk) => chunk.ok && chunk.kind === "data")?.codecId;
  const decodeLog = buildDecodeSummary(decodedChunks, decodeMessages);
  function resetDecode() {
    setDecodedChunks([]);
    setRecoveredFile(null);
    setHasDownloadedRecoveredFile(false);
    setDecodeMessages([]);
    setDecodeProgress(null);
    setReadParts([]);
    setVerificationStatus("");
  }

  function handleFileSelection(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    if (!file) {
      return;
    }
    if (file.name.length > 1024) {
      setFileSelectionMessage("filename is too long");
      event.target.value = "";
      selectFile(null);
      return;
    }
    setFileSelectionMessage("");
    selectFile(file);
  }

  function selectFile(file: File | null) {
    setSelectedFile(file);
    setCoverVideo(null);
    encodedVideos.forEach((video) => URL.revokeObjectURL(video.url));
    setEncodedVideos([]);
    setEncodeError("");
    setPublishMessage("");
    setPublishedUrl("");
    setPublishQueuePosition(null);
    setPublishRequestId(file ? crypto.randomUUID() : "");
  }

  function handleCoverSelection(event: ChangeEvent<HTMLInputElement>) {
    setCoverMedia(event.target.files?.[0] ?? null);
    setCoverVideo(null);
  }

  function handleFileDrag(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    if (event.dataTransfer.types.includes("Files")) {
      setIsFileDragActive(true);
    }
  }

  function handleFileDragLeave(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setIsFileDragActive(false);
    }
  }

  function handleFileDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsFileDragActive(false);
    selectFile(event.dataTransfer.files?.[0] ?? null);
  }

  async function generateVideoForFile(file: File) {
    resetDecode();
    setEncodeError("");
    setIsEncodingVideo(true);
    setEncodeProgress({ phase: "Starting", completed: 0, total: 1 });
    encodedVideos.forEach((video) => URL.revokeObjectURL(video.url));
    setEncodedVideos([]);
    try {
      const videos = await encodeFileAsVideos(file, setEncodeProgress);
      if (videos.length >= 8) {
        throw new Error(`This file needs more than eight carousel videos. Choose a file ${activeFileLimitLabel} or smaller so the display and repair videos fit.`);
      }
      setEncodedVideos(videos);
      setEncodeProgress({ phase: videos.length > 1 ? "MP4 set ready" : "MP4 ready", completed: videos.length, total: videos.length });
    } catch (error) {
      setEncodeError(error instanceof Error ? error.message : String(error));
      setEncodeProgress(null);
    } finally {
      setIsEncodingVideo(false);
    }
  }

  async function handleReadUrl(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const url = normalizeReadUrl(readUrl);
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
      setReadParts(Array.from({ length: result.parts }, (_, index) => ({
        label: `data video ${index + 1}`,
        status: "waiting"
      })));
      setVerificationStatus("waiting");
      const videos: File[] = [];
      for (let part = 0; part < result.parts; part += 1) {
        setReadParts((current) => current.map((item, index) =>
          index === part ? { ...item, status: "downloading" } : item
        ));
        setDecodeMessages([`Downloading video ${part + 1} of ${result.parts}...`]);
        let videoResponse: Response | null = null;
        let downloadError = "";
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try {
            videoResponse = await fetch(`/api/instagram/read?url=${encodeURIComponent(url)}&part=${part}`);
            if (videoResponse.ok) break;
            const error = await readJsonResponse(videoResponse);
            downloadError = error.error || `Video ${part + 1} could not be downloaded.`;
          } catch (error) {
            downloadError = error instanceof Error ? error.message : String(error);
          }
          if (attempt < 3) await new Promise((resolve) => window.setTimeout(resolve, attempt * 1000));
        }
        if (!videoResponse?.ok) throw new Error(downloadError || `Video ${part + 1} could not be downloaded.`);
        const blob = await videoResponse.blob();
        videos.push(new File([blob], `instagram-${part + 1}.mp4`, { type: "video/mp4" }));
        setReadParts((current) => current.map((item, index) =>
          index === part ? { ...item, status: "downloaded" } : item
        ));
      }
      setIsFetchingReadUrl(false);
      await decodeVideoFiles(videos, true, true);
    } catch (error) {
      setReadParts((current) => current.map((item) =>
        item.status === "downloading" ? { ...item, status: "failed" } : item
      ));
      setVerificationStatus("failed");
      setDecodeMessages([error instanceof Error ? error.message : "Instagram URL could not be read."]);
    } finally {
      setIsFetchingReadUrl(false);
    }
  }

  function handleMakeShareLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const instagramUrl = normalizeReadUrl(shareInstagramUrl);
    if (!instagramUrl) return;
    setFileShareLink(makeFileShareLink(instagramUrl));
    setCopiedShareLink("");
  }

  async function copyShareLink(link: string) {
    await navigator.clipboard.writeText(link);
    setCopiedShareLink(link);
  }

  async function decodeVideoFiles(files: File[], prepareDownloadWhenComplete = false, preserveReadStatus = false) {
    const videos = files.filter((file) => file.type.startsWith("video/") || file.name.toLowerCase().endsWith(".mp4"));
    if (!preserveReadStatus) resetDecode();
    if (!videos.length) return;

    setIsDecodingVideo(true);
    const allDecodedChunks: DecodeResult[] = [];
    const messages: string[] = [];
    let mergedChunks: DecodeResult[] = [];
    let expectedFileIdentity: string | null = null;
    try {
      for (let index = 0; index < videos.length; index++) {
        const file = videos[index];
        if (preserveReadStatus) {
          setReadParts((current) => current.map((item, partIndex) =>
            partIndex === index ? { ...item, status: "decoding" } : item
          ));
        }
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
        const identityChunk = chunks.find((chunk) => chunk.ok);
        const fileIdentity = identityChunk
          ? [
              identityChunk.fileHash,
              identityChunk.fileSize,
              identityChunk.totalChunks,
              identityChunk.fileName
            ].join(":")
          : null;
        if (fileIdentity && expectedFileIdentity && fileIdentity !== expectedFileIdentity) {
          throw new Error(`Carousel data video ${index + 1} belongs to a different encoded file.`);
        }
        if (fileIdentity && !expectedFileIdentity) expectedFileIdentity = fileIdentity;
        allDecodedChunks.push(...chunks);
        mergedChunks = recoverDataChunks(allDecodedChunks);
        const recoveredChunks = chunks.filter((chunk) => chunk.ok && chunk.kind === "data");
        setDecodedChunks(mergedChunks);
        messages.push(
          `${file.name}: recovered ${chunks.length ? `${recoveredChunks.length}/${chunks[0].totalChunks}` : "0"} chunks; merged ${mergedChunks.length}.`
        );
        setDecodeMessages([...messages]);
        if (preserveReadStatus) {
          setReadParts((current) => current.map((item, partIndex) =>
            partIndex === index ? { ...item, status: "decoded" } : item
          ));
        }
      }
      setDecodeProgress({ phase: "Decode complete", completed: videos.length, total: videos.length });
      const totalChunks = mergedChunks[0]?.totalChunks ?? 0;
      if (prepareDownloadWhenComplete && totalChunks > 0 && mergedChunks.length === totalChunks) {
        setVerificationStatus("verifying");
        const assembled = await reassemble(mergedChunks);
        if (!assembled.hashOk) {
          throw new Error(`Recovered file failed SHA-256 verification (expected ${assembled.expectedHash}, got ${assembled.hash}).`);
        }
        setVerificationStatus("ready");
        setRecoveredFile({ blob: assembled.blob, fileName: assembled.fileName });
        setHasDownloadedRecoveredFile(false);
        setDecodeMessages((current) => [
          ...current,
          `Recovered ${assembled.fileName}. SHA-256 OK. Ready to download.`
        ]);
      } else if (prepareDownloadWhenComplete) {
        throw new Error(`Only ${mergedChunks.length}/${totalChunks || "?"} chunks were recovered.`);
      }
    } catch (error) {
      if (preserveReadStatus) {
        setReadParts((current) => current.map((item) =>
          item.status === "decoding" ? { ...item, status: "failed" } : item
        ));
        setVerificationStatus("failed");
      }
      setDecodeMessages([...messages, `Video decode failed: ${error instanceof Error ? error.message : String(error)}`]);
      setDecodeProgress({ phase: "Decode failed", completed: 1, total: 1 });
    } finally {
      setIsDecodingVideo(false);
    }
  }

  async function handleAssemble() {
    if (hasDownloadedRecoveredFile || isPreparingRecoveredDownload) return;
    let file = recoveredFile;
    if (!file) {
      const assembled = await reassemble(decodedChunks);
      if (!assembled.hashOk) {
        setDecodeMessages((current) => [
          ...current,
          `Download blocked: ${assembled.fileName} failed SHA-256 verification.`
        ]);
        return;
      }
      file = { blob: assembled.blob, fileName: assembled.fileName };
      setRecoveredFile(file);
    }
    setIsPreparingRecoveredDownload(true);
    try {
      const recoveredBrowserFile = new File([file.blob], file.fileName, {
        type: file.blob.type || "application/octet-stream"
      });
      const isInstagramBrowser = /Instagram/i.test(navigator.userAgent);
      const canShareFile = typeof navigator.share === "function"
        && typeof navigator.canShare === "function"
        && navigator.canShare({ files: [recoveredBrowserFile] });

      if (isInstagramBrowser && canShareFile) {
        await navigator.share({ files: [recoveredBrowserFile] });
        setHasDownloadedRecoveredFile(true);
        setDecodeMessages((current) => [
          ...current,
          `Sent ${file.fileName} to the save/share menu. SHA-256 OK.`
        ]);
        return;
      }

      const form = new FormData();
      form.append("file", file.blob, file.fileName);
      const response = await fetch("/api/recovered-download", { method: "POST", body: form });
      const result = await response.json() as { downloadUrl?: string; error?: string };
      if (!response.ok || !result.downloadUrl) {
        throw new Error(result.error || "Download could not be prepared.");
      }
      setDecodeMessages((current) => [
        ...current,
        `Opening the download for ${file.fileName}. SHA-256 OK.`
      ]);
      window.location.assign(result.downloadUrl);
      setHasDownloadedRecoveredFile(true);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setDecodeMessages((current) => [
        ...current,
        error instanceof Error ? error.message : "Download could not be prepared."
      ]);
    } finally {
      setIsPreparingRecoveredDownload(false);
    }
  }

  async function handlePublishToInstagram() {
    if (!selectedFile || !encodedVideos.length || !coverVideo || isPublishing || publishSucceeded) return;
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
      setPublishParts(uploadParts.map((_, index) => ({
        label: index === 0 ? "cover" : `data video ${index}`,
        status: "waiting"
      })));
      const uploadPart = async (index: number, uploadId = "", uploadToken = "") => {
        setPublishParts((current) => current.map((part, partIndex) =>
          partIndex === index ? { ...part, status: "uploading" } : part
        ));
        setPublishMessage(`Uploading video ${index + 1} of ${uploadParts.length}...`);
        const video = uploadParts[index];
        const form = new FormData();
        form.set("video", video.blob, video.fileName);
        if (video.audioPayload && video.audioPayload.size > 0) {
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
        setPublishParts((current) => current.map((part, partIndex) =>
          partIndex === index ? { ...part, status: "processing" } : part
        ));
        return { uploadId: uploadResult.uploadId, uploadToken: uploadResult.uploadToken };
      };
      const firstUpload = await uploadPart(0);
      await Promise.all(
        uploadParts.slice(1).map((_, offset) => uploadPart(offset + 1, firstUpload.uploadId, firstUpload.uploadToken))
      );
      const uploadId = firstUpload.uploadId;
      const uploadToken = firstUpload.uploadToken;
      setPublishMessage("Verifying the normalized videos before publishing...");
      const normalizedParts: DecodeResult[] = [];
      for (let index = 1; index < uploadParts.length; index += 1) {
        const stagedName = `part-${String(index + 1).padStart(2, "0")}.mp4`;
        const stagedResponse = await fetch(
          `/api/instagram/media/${encodeURIComponent(uploadId)}/${stagedName}?token=${encodeURIComponent(uploadToken)}`,
          { cache: "no-store" }
        );
        if (!stagedResponse.ok) throw new Error(`Normalized data video ${index} could not be checked.`);
        const stagedFile = new File([await stagedResponse.blob()], stagedName, { type: "video/mp4" });
        const chunks = await decodeVideoFile(stagedFile, (progress) => {
          setPublishMessage(
            `Verifying normalized video ${index} of ${uploadParts.length - 1}: ${progress.phase.toLowerCase()}...`
          );
        });
        normalizedParts.push(...chunks);
        setPublishParts((current) => current.map((part, partIndex) =>
          partIndex === index ? { ...part, status: "ready" } : part
        ));
      }
      const verifiedChunks = recoverDataChunks(normalizedParts);
      const expectedChunks = verifiedChunks[0]?.totalChunks ?? 0;
      if (!expectedChunks || verifiedChunks.length !== expectedChunks) {
        throw new Error(
          `Upload stopped before Instagram: the normalized videos recovered only ${verifiedChunks.length}/${expectedChunks || "?"} chunks.`
        );
      }
      const normalizedFile = await reassemble(verifiedChunks);
      if (!normalizedFile.hashOk || normalizedFile.blob.size !== selectedFile.size) {
        throw new Error("Upload stopped before Instagram: the normalized videos failed SHA-256 verification.");
      }
      setPublishMessage("Publishing to @normal_shopkeep\u2026 keep this window open.");
      const requestId = publishRequestId || crypto.randomUUID();
      if (!publishRequestId) setPublishRequestId(requestId);
      const publishBody = {
        uploadId,
        uploadToken,
        originalName: selectedFile.name,
        originalType: selectedFile.type || "application/octet-stream",
        originalSize: selectedFile.size,
        addedBy: addedBy.trim(),
        note: publishNote.trim(),
        confirmation: "publish-to-normal-shopkeep",
        publishRequestId: requestId
      };
      let result: Awaited<ReturnType<typeof readJsonResponse>>;
      try {
        const response = await fetch("/api/instagram/publish", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Accept": "application/json" },
          body: JSON.stringify(publishBody)
        });
        result = await readJsonResponse(response);
        if (!response.ok) throw new Error(result.error || "Instagram publishing failed.");
        if (result.status === "queued" || result.status === "processing") {
          setPublishQueuePosition(result.queuePosition ?? null);
          const confirmed = await waitForPublishedRequest(requestId, setPublishParts, setPublishQueuePosition);
          if (!confirmed) throw new Error("Instagram is still processing the post. Keep this window open and try again shortly.");
          result = confirmed;
        }
      } catch (error) {
        setPublishMessage("Confirming the Instagram post...");
        const confirmed = await waitForPublishedRequest(requestId, setPublishParts, setPublishQueuePosition);
        if (!confirmed) throw error;
        result = confirmed;
      }
      if (result.permalink) setPublishedUrl(result.permalink);
      setPublishQueuePosition(null);
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
        <span className="site-title">
          <img src="/icon.png" alt="" aria-hidden="true" />
          Normal Shopkeep
        </span>
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
          <button
            type="button"
            className={activeTab === "share" ? "active" : ""}
            aria-current={activeTab === "share" ? "page" : undefined}
            onClick={() => setActiveTab("share")}
          >
            Make a share link
          </button>
          <button
            type="button"
            className={`about-tab${activeTab === "about" ? " active" : ""}`}
            aria-current={activeTab === "about" ? "page" : undefined}
            onClick={() => setActiveTab("about")}
          >
            About
          </button>
        </nav>
      </header>

      <main>

      {activeTab === "about" ? (
        <section className="tab-panel about-layout">
          <fieldset className="panel about-panel">
            <legend>about</legend>
            <p>
              Normal Shopkeep is a website facilitating the use of Instagram as a community flash drive.
            </p>
            <p>
              Use Write to upload files and Read to download them.
            </p>
            <h2>to write a file</h2>
            <ol>
              <li>Choose your file.</li>
              <li>Generate the MP4s.</li>
              <li>Add any optional information.</li>
              <li>Publish to Instagram and keep the page open until publishing is complete. The data videos will automatically be posted to @normal_shopkeep.</li>
            </ol>
            <h2>to read a file</h2>
            <p>
              Enter the Instagram post URL, press Read URL, and wait for the file to be recovered. Once it is ready, press Download Recovered File.
            </p>
            <h2>to make a share link</h2>
            <p>
              Open Make a share link and enter the URL of a post. The resulting link takes a person directly to the Read page with that post already filled in.
            </p>
            <p>
              Normal Shopkeep is named after the shopkeep in <a href="https://www.youtube.com/watch?v=_F9EMbkvLBQ" target="_blank" rel="noreferrer">this video</a>.
            </p>
            <p>
              Made by <a href="https://www.andrew-boylan.com/" target="_blank" rel="noreferrer">Andrew Boylan</a>.
            </p>
            <p>
              <a href="https://ko-fi.com/goodbyeoblivion" target="_blank" rel="noreferrer">Support Normal Shopkeep on Ko-fi</a>.
            </p>

          </fieldset>
        </section>
      ) : activeTab === "share" ? (
        <section className="tab-panel share-layout">
          <fieldset className="panel share-panel">
            <legend>make a file share link</legend>
            <form onSubmit={handleMakeShareLink}>
              <label className="field-label" htmlFor="share-instagram-url">
                Instagram URL
                <input
                  id="share-instagram-url"
                  type="url"
                  inputMode="url"
                  placeholder="https://www.instagram.com/p/.../"
                  value={shareInstagramUrl}
                  onChange={(event) => {
                    setShareInstagramUrl(event.target.value);
                    setFileShareLink("");
                    setCopiedShareLink("");
                  }}
                />
              </label>
              <div className="button-row">
                <button type="submit" disabled={!normalizeReadUrl(shareInstagramUrl)}>make link</button>
                {normalizeReadUrl(shareInstagramUrl) && !fileShareLink
                  ? <span className="next-step-arrow" aria-hidden="true">←</span>
                  : null}
              </div>
            </form>
            {fileShareLink ? (
              <ShareLinkField
                link={fileShareLink}
                copied={copiedShareLink === fileShareLink}
                onCopy={() => copyShareLink(fileShareLink)}
              />
            ) : null}
          </fieldset>
        </section>
      ) : activeTab === "read" ? (
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
                <button type="submit" disabled={!normalizedReadUrl || isFetchingReadUrl || isDecodingVideo}>
                  {isFetchingReadUrl ? "downloading..." : isDecodingVideo ? "decoding..." : "read URL"}
                </button>
                {normalizedReadUrl && !isFetchingReadUrl && !isDecodingVideo && !recoveredFile
                  ? <span className="next-step-arrow" aria-hidden="true">←</span>
                  : null}
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
              <div>
                <dt>codec</dt>
                <dd>{recoveredCodec ?? "—"}</dd>
              </div>
            </dl>

            <div className="button-row">
              <button type="button" disabled={!recoveredFile || hasDownloadedRecoveredFile || isPreparingRecoveredDownload} onClick={handleAssemble}>
                {hasDownloadedRecoveredFile ? "Downloaded" : isPreparingRecoveredDownload ? "preparing download..." : "Download Recovered File"}
              </button>
              {recoveredFile && !hasDownloadedRecoveredFile ? <span className="next-step-arrow" aria-hidden="true">←</span> : null}
            </div>

            {readParts.length ? (
              <dl className="publish-parts" aria-label="File recovery status">
                {readParts.map((part) => (
                  <div key={part.label}>
                    <dt>{part.label}</dt>
                    <dd>{part.status}</dd>
                  </div>
                ))}
                <div>
                  <dt>recovered file</dt>
                  <dd>{verificationStatus}</dd>
                </div>
              </dl>
            ) : null}

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
            <div
              className={`dropzone${isFileDragActive ? " drag-active" : ""}`}
              onDragEnter={handleFileDrag}
              onDragOver={handleFileDrag}
              onDragLeave={handleFileDragLeave}
              onDrop={handleFileDrop}
            >
              <span className="file-picker-action">
                <input
                  id="file-input"
                  type="file"
                  onClick={() => setFileSelectionMessage("")}
                  onChange={handleFileSelection}
                />
                {nextWriteStep === "choose-file" ? <span className="next-step-arrow" aria-hidden="true">←</span> : null}
                {fileSelectionMessage ? <span className="file-error" role="alert">{fileSelectionMessage}</span> : null}
              </span>
              {selectedFile ? <strong>{selectedFile.name} ({formatBytes(selectedFile.size)})</strong> : null}
            </div>

            {fileTooLarge ? <p className="file-error" role="alert">file exceeds the {activeFileLimitLabel} maximum</p> : null}
            <div className="button-row">
              <button
                type="button"
                onClick={() => selectedFile && generateVideoForFile(selectedFile)}
                disabled={!selectedFile || fileTooLarge || isEncodingVideo || isEncodingDisplayVideo || !coverVideo}
              >
                {isEncodingVideo ? "encoding..." : isEncodingDisplayVideo ? "preparing preview..." : "generate MP4"}
              </button>
              {nextWriteStep === "generate-mp4" ? <span className="next-step-arrow" aria-hidden="true">←</span> : null}
            </div>

            {encodeProgress ? <ProgressView progress={encodeProgress} active={isEncodingVideo} label="Encoding progress" /> : null}
            {encodeError ? <p className="file-error" role="alert">MP4 generation failed: {encodeError}</p> : null}

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
                    <fieldset className="display-video-placeholder-frame">
                      <legend>Normal Shopkeep</legend>
                      {isEncodingDisplayVideo ? <span>preparing preview...</span> : null}
                    </fieldset>
                  </div>
                )}
              </div>
              <div className="field-label">
                <label htmlFor="cover-media-input">GIF/image (optional)</label>
                <div className="dropzone compact-picker">
                  <input id="cover-media-input" type="file" accept="image/*" onChange={handleCoverSelection} />
                  {coverMedia ? <strong>{coverMedia.name}</strong> : null}
                </div>
              </div>
              <label className="field-label" htmlFor="instagram-added-by">
                added by (optional)
                <input
                  id="instagram-added-by"
                  type="text"
                  value={addedBy}
                  maxLength={100}
                  onChange={(event) => setAddedBy(event.target.value)}
                />
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
                  disabled={!selectedFile || fileTooLarge || !encodedVideos.length || !coverVideo || isPublishing || publishSucceeded}
                  onClick={handlePublishToInstagram}
                >
                  {isPublishing ? "publishing..." : publishSucceeded ? "published to Instagram" : "publish to Instagram"}
                </button>
                {nextWriteStep === "publish-instagram" ? <span className="next-step-arrow" aria-hidden="true">←</span> : null}
              </div>

              {publishMessage ? <p className="publish-status" role="status">{publishMessage}</p> : null}
              {publishQueuePosition && publishQueuePosition > 1 ? (
                <p className="publish-status" role="status">Instagram queue position: {publishQueuePosition}</p>
              ) : null}
              {publishParts.length ? (
                <dl className="publish-parts" aria-label="Instagram video processing status">
                  {publishParts.map((part) => (
                    <div key={part.label}>
                      <dt>{part.label}</dt>
                      <dd>{part.status}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
              {publishedUrl ? <a className="published-link" href={publishedUrl} target="_blank" rel="noreferrer">open Instagram post</a> : null}
              {publishedUrl ? (
                <ShareLinkField
                  link={makePermanentShareLink(publishRequestId)}
                  copied={copiedShareLink === makePermanentShareLink(publishRequestId)}
                  onCopy={() => copyShareLink(makePermanentShareLink(publishRequestId))}
                />
              ) : null}
          </fieldset>
        </section>
      )}
      </main>
    </div>
  );
}

function ShareLinkField({ link, copied, onCopy }: { link: string; copied: boolean; onCopy: () => void }) {
  return (
    <div className="share-link-field">
      <label className="field-label">
        file share link
        <input type="url" readOnly value={link} onFocus={(event) => event.currentTarget.select()} />
      </label>
      <div className="button-row">
        <button type="button" disabled={copied} onClick={onCopy}>{copied ? "copied" : "copy link"}</button>
        {!copied ? <span className="next-step-arrow" aria-hidden="true">←</span> : null}
      </div>
    </div>
  );
}

function makeFileShareLink(instagramUrl: string) {
  const url = new URL("/", window.location.origin);
  url.searchParams.set("read", instagramUrl);
  return url.toString();
}

function makePermanentShareLink(shareId: string) {
  const url = new URL("/", window.location.origin);
  url.searchParams.set("share", shareId);
  return url.toString();
}

function isValidShareId(value: string) {
  return /^[a-zA-Z0-9-]{16,80}$/.test(value);
}

async function resolvePermanentShareLink(shareId: string) {
  const response = await fetch(`/api/instagram/share?id=${encodeURIComponent(shareId)}`, {
    headers: { "Accept": "application/json" },
    cache: "no-store"
  });
  const result = await readJsonResponse(response);
  if (!response.ok || !result.permalink) {
    throw new Error(result.error || "File share link could not be resolved.");
  }
  return result.permalink;
}

function normalizeReadUrl(input: string) {
  try {
    const url = new URL(input.trim());
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    if (url.protocol !== "https:" || hostname !== "instagram.com") return "";
    const match = url.pathname.match(/^\/(p|reel)\/([A-Za-z0-9_-]+)\/?$/);
    return match ? `https://www.instagram.com/${match[1]}/${match[2]}/` : "";
  } catch {
    return "";
  }
}

async function waitForPublishedRequest(
  publishRequestId: string,
  onVideos?: (videos: PublishPartStatus[]) => void,
  onQueuePosition?: (position: number | null) => void
) {
  for (let attempt = 0; attempt < 900; attempt += 1) {
    try {
      const response = await fetch("/api/instagram/status", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ publishRequestId }),
        cache: "no-store"
      });
      if (response.ok) {
        const result = await readJsonResponse(response);
        if (result.videos?.length) onVideos?.(result.videos);
        onQueuePosition?.(typeof result.queuePosition === "number" ? result.queuePosition : null);
        if (result.status === "published") return result;
        if (result.status === "failed") throw new Error(result.error || "Instagram publishing failed.");
      }
    } catch (error) {
      if (error instanceof Error && error.message !== "Failed to fetch") throw error;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 2000));
  }
  return null;
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
    status?: "queued" | "processing" | "published" | "failed";
    queuePosition?: number;
    videos?: PublishPartStatus[];
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
  const codec = dataChunks[0] ? `${dataChunks[0].codecId} (payload v${dataChunks[0].payloadVersion})` : "unknown";
  const recoveredIndexes = new Set(dataChunks.map((chunk) => chunk.chunkIndex));
  const missingIndexes =
    totalChunks > 0
      ? Array.from({ length: totalChunks }, (_, index) => index).filter((index) => !recoveredIndexes.has(index))
      : [];

  return [
    `Recovered ${dataChunks.length}/${totalChunks || "?"} data chunks for ${fileName}.`,
    `Codec: ${codec}.`,
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
