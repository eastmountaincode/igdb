const BACKEND_URL = process.env.IGDB_BACKEND_URL;

export function backendUrl(path: string) {
  if (!BACKEND_URL) return undefined;
  return new URL(path, BACKEND_URL).toString();
}

