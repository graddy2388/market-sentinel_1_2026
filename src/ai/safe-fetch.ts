/**
 * Safe image fetcher with SSRF protection, size limits, and timeouts.
 *
 * Used by vision handlers to fetch Discord attachment images.
 * Blocks internal/private network ranges and enforces a response size cap.
 */

const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10 MB
const FETCH_TIMEOUT_MS = 15_000; // 15 seconds

/** Hosts allowed for image fetches. Discord CDN domains only. */
const ALLOWED_HOSTS = [
  "cdn.discordapp.com",
  "media.discordapp.net",
];

/**
 * Validate and safely fetch an image URL.
 *
 * Protections:
 * - URL must be HTTPS
 * - Hostname must be on the allow-list (Discord CDN)
 * - Response body is capped at MAX_IMAGE_SIZE (10 MB)
 * - Fetch has a 15-second timeout via AbortSignal
 * - Content-Type must be an image type
 *
 * @throws Error if the URL is blocked, too large, times out, or isn't an image.
 */
export async function safeFetchImage(imageUrl: string): Promise<{
  buffer: Buffer;
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
}> {
  // --- URL validation ---
  let parsed: URL;
  try {
    parsed = new URL(imageUrl);
  } catch {
    throw new Error("Invalid image URL");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("Image URL must use HTTPS");
  }

  if (!ALLOWED_HOSTS.includes(parsed.hostname)) {
    throw new Error(`Image host not allowed: ${parsed.hostname}`);
  }

  // --- Fetch with timeout ---
  const res = await fetch(imageUrl, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: "error", // Don't follow redirects to prevent redirect-based SSRF
  });

  if (!res.ok) {
    throw new Error(`Image fetch failed: HTTP ${res.status}`);
  }

  // --- Content-Type check ---
  const contentType = res.headers.get("content-type") ?? "";
  let mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  if (contentType.includes("image/jpeg") || contentType.includes("image/jpg")) {
    mediaType = "image/jpeg";
  } else if (contentType.includes("image/png")) {
    mediaType = "image/png";
  } else if (contentType.includes("image/gif")) {
    mediaType = "image/gif";
  } else if (contentType.includes("image/webp")) {
    mediaType = "image/webp";
  } else {
    throw new Error(`Not an image: ${contentType}`);
  }

  // --- Size-limited read ---
  const contentLength = res.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_IMAGE_SIZE) {
    throw new Error(`Image too large: ${contentLength} bytes (max ${MAX_IMAGE_SIZE})`);
  }

  // Stream the body with a running size check
  const reader = res.body?.getReader();
  if (!reader) {
    throw new Error("No response body");
  }

  const chunks: Uint8Array[] = [];
  let totalSize = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalSize += value.length;
      if (totalSize > MAX_IMAGE_SIZE) {
        reader.cancel();
        throw new Error(`Image too large: exceeded ${MAX_IMAGE_SIZE} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const buffer = Buffer.concat(chunks);
  return { buffer, mediaType };
}
