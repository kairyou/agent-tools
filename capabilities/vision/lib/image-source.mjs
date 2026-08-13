// Image acquisition: explicit local file paths and http(s) URLs only. No
// directory enumeration, globbing, or implicit search — the caller must name
// one concrete image. URLs are unrestricted by host/IP (personal local tool);
// protection is resource-based: timeout, redirect cap, size cap, and image
// signature validation.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ERROR_CODES, VisionError } from "./errors.mjs";

export const SUPPORTED_MEDIA_TYPES = Object.freeze([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

const MAX_REDIRECTS = 5;

// Identify the image type from magic bytes; extensions and Content-Type
// headers are hints only and are never trusted.
export function sniffMediaType(bytes) {
  if (!bytes || bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return "image/gif";
  }
  return null;
}

function validateImageHeader(header, byteLength, origin, maxImageBytes) {
  if (byteLength === 0) {
    throw new VisionError(ERROR_CODES.INPUT, `${origin} is empty.`);
  }
  if (byteLength > maxImageBytes) {
    throw new VisionError(
      ERROR_CODES.INPUT,
      `${origin} is ${byteLength} bytes, over the ${maxImageBytes}-byte limit (vision.maxImageBytes).`
    );
  }
  const mediaType = sniffMediaType(header);
  if (!mediaType) {
    throw new VisionError(
      ERROR_CODES.INPUT,
      `${origin} is not a supported image (expected PNG, JPEG, WebP, or GIF).`
    );
  }
  return mediaType;
}

function loadFile(value, maxImageBytes) {
  const resolved = path.resolve(value);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new VisionError(ERROR_CODES.INPUT, `Image file not found: ${resolved}`);
  }
  if (!stat.isFile()) {
    throw new VisionError(ERROR_CODES.INPUT, `Not a file: ${resolved} (directories are not accepted).`);
  }
  if (stat.size > maxImageBytes) {
    throw new VisionError(
      ERROR_CODES.INPUT,
      `${resolved} is ${stat.size} bytes, over the ${maxImageBytes}-byte limit (vision.maxImageBytes).`
    );
  }
  let handle;
  try {
    handle = fs.openSync(resolved, "r");
    const header = Buffer.alloc(12);
    const headerLength = fs.readSync(handle, header, 0, header.length, 0);
    const mediaType = validateImageHeader(
      header.subarray(0, headerLength),
      stat.size,
      resolved,
      maxImageBytes
    );
    let disposed = false;
    return {
      mediaType,
      byteLength: stat.size,
      createReadStream: () => fs.createReadStream(resolved, { fd: handle, autoClose: false, start: 0 }),
      dispose() {
        if (disposed) return;
        disposed = true;
        fs.closeSync(handle);
      },
    };
  } catch (err) {
    if (handle !== undefined) fs.closeSync(handle);
    if (err instanceof VisionError) throw err;
    throw new VisionError(ERROR_CODES.INPUT, `Cannot read ${resolved}: ${err.message}`);
  }
}

async function downloadCapped(response, url, maxImageBytes) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxImageBytes) {
    throw new VisionError(
      ERROR_CODES.INPUT,
      `${url} declares ${declared} bytes, over the ${maxImageBytes}-byte limit (vision.maxImageBytes).`
    );
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-tools-vision-"));
  const tempFile = path.join(tempDir, "image");
  const handle = await fs.promises.open(tempFile, "wx", 0o600);
  const header = Buffer.alloc(12);
  let headerLength = 0;
  let total = 0;
  try {
    for await (const value of response.body) {
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxImageBytes) {
        throw new VisionError(
          ERROR_CODES.INPUT,
          `${url} exceeded the ${maxImageBytes}-byte limit (vision.maxImageBytes) while downloading.`
        );
      }
      if (headerLength < header.length) {
        const copied = chunk.copy(header, headerLength, 0, header.length - headerLength);
        headerLength += copied;
      }
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset, null);
        if (bytesWritten === 0) throw new Error(`Could not write downloaded image data for ${url}.`);
        offset += bytesWritten;
      }
    }
  } catch (error) {
    await handle.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
  await handle.close();
  let mediaType;
  try {
    mediaType = validateImageHeader(header.subarray(0, headerLength), total, url, maxImageBytes);
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
  let disposed = false;
  return {
    mediaType,
    byteLength: total,
    tempFile,
    createReadStream: () => fs.createReadStream(tempFile),
    dispose() {
      if (disposed) return;
      disposed = true;
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

function requireHttpUrl(value, code, message) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new VisionError(code, message);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new VisionError(code, message);
  }
  return parsed;
}

async function discardRedirectBody(response) {
  if (response.body && typeof response.body.cancel === "function") {
    try {
      await response.body.cancel();
    } catch {
      // Redirect metadata remains usable even if connection cleanup fails.
    }
  }
}

async function loadUrl(value, { maxImageBytes, timeoutMs, fetchImpl }) {
  const invalidInitial = `Only valid http(s) URLs are supported: ${value}`;
  let current = requireHttpUrl(value, ERROR_CODES.INPUT, invalidInitial);

  const doFetch = fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let response;
      try {
        response = await doFetch(current.href, { redirect: "manual", signal: controller.signal });
      } catch (err) {
        if (controller.signal.aborted) {
          throw new VisionError(ERROR_CODES.FETCH, `Timed out fetching ${current.href} after ${timeoutMs}ms.`);
        }
        throw new VisionError(ERROR_CODES.FETCH, `Cannot fetch ${current.href}: ${err.message}`, { cause: err });
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          await discardRedirectBody(response);
          throw new VisionError(ERROR_CODES.FETCH, `${current.href} redirected without a Location header.`);
        }
        if (hop === MAX_REDIRECTS) {
          await discardRedirectBody(response);
          throw new VisionError(ERROR_CODES.FETCH, `${value} exceeded ${MAX_REDIRECTS} redirects.`);
        }
        let redirected;
        try {
          redirected = new URL(location, current);
        } catch {
          await discardRedirectBody(response);
          throw new VisionError(ERROR_CODES.FETCH, `${current.href} redirected to an invalid URL: ${location}`);
        }
        if (redirected.protocol !== "http:" && redirected.protocol !== "https:") {
          await discardRedirectBody(response);
          throw new VisionError(
            ERROR_CODES.FETCH,
            `${current.href} redirected to unsupported protocol ${redirected.protocol}`
          );
        }
        await discardRedirectBody(response);
        current = redirected;
        continue;
      }
      if (!response.ok) {
        throw new VisionError(ERROR_CODES.FETCH, `${current.href} returned HTTP ${response.status}.`);
      }
      try {
        return await downloadCapped(response, current.href, maxImageBytes);
      } catch (err) {
        if (err instanceof VisionError) throw err;
        if (controller.signal.aborted) {
          throw new VisionError(ERROR_CODES.FETCH, `Timed out fetching ${current.href} after ${timeoutMs}ms.`);
        }
        throw new VisionError(ERROR_CODES.FETCH, `Cannot read ${current.href}: ${err.message}`, { cause: err });
      }
    }
    throw new VisionError(ERROR_CODES.FETCH, `${value} exceeded ${MAX_REDIRECTS} redirects.`);
  } finally {
    clearTimeout(timer);
  }
}

// source: { type: "file" | "url", value: string }
// Returns a disposable, repeatable stream source. URL downloads are spooled to
// a private temporary file so provider serialization never needs the complete
// image or its base64 representation in memory.
export async function loadImageSource(source, { maxImageBytes, timeoutMs, fetchImpl } = {}) {
  if (!source || typeof source !== "object" || typeof source.value !== "string" || source.value.trim() === "") {
    throw new VisionError(
      ERROR_CODES.INPUT,
      'image_source must be { "type": "file" | "url", "value": "<path or url>" }.'
    );
  }
  if (source.type === "file") return loadFile(source.value, maxImageBytes);
  if (source.type === "url") return loadUrl(source.value, { maxImageBytes, timeoutMs, fetchImpl });
  throw new VisionError(ERROR_CODES.INPUT, `Unsupported image_source.type: ${JSON.stringify(source.type)}`);
}
