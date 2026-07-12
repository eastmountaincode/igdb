export type InstagramFileMetadata = {
  name: string;
  type: string;
  size: number;
  note?: string;
};

export function buildInstagramCaption(metadata: InstagramFileMetadata) {
  const lines = [
    `File name: ${metadata.name}`,
    `File type: ${metadata.type || "application/octet-stream"}`,
    `File size: ${formatCaptionBytes(metadata.size)}`
  ];

  const note = metadata.note?.trim();
  if (note) lines.push("", `Note: ${note}`);
  return `\n${lines.join("\n")}`;
}

export function formatCaptionBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}
