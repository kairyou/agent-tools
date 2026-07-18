import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadImageSource, sniffMediaType } from "../lib/vision/image-source.mjs";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.alloc(4),
  Buffer.from("WEBP"),
  Buffer.alloc(16),
]);
const GIF = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(16)]);
const LIMITS = { maxImageBytes: 1024, timeoutMs: 2000 };

const tmp = mkdtempSync(join(tmpdir(), "at-vision-img-"));

function writeTmp(name, bytes) {
  const file = join(tmp, name);
  writeFileSync(file, bytes);
  return file;
}

test("sniffMediaType identifies supported formats from magic bytes", () => {
  assert.equal(sniffMediaType(PNG), "image/png");
  assert.equal(sniffMediaType(JPEG), "image/jpeg");
  assert.equal(sniffMediaType(WEBP), "image/webp");
  assert.equal(sniffMediaType(GIF), "image/gif");
  assert.equal(sniffMediaType(Buffer.from("plain text, not an image")), null);
});

test("file source loads a real image and reports its media type", async () => {
  const file = writeTmp("ok.png", PNG);
  const result = await loadImageSource({ type: "file", value: file }, LIMITS);
  assert.equal(result.mediaType, "image/png");
  assert.equal(result.bytes.length, PNG.length);
});

test("file source rejects missing files, directories, and non-images", async () => {
  await assert.rejects(
    loadImageSource({ type: "file", value: join(tmp, "nope.png") }, LIMITS),
    (err) => err.code === "input_error" && /not found/.test(err.message)
  );
  await assert.rejects(
    loadImageSource({ type: "file", value: tmp }, LIMITS),
    (err) => err.code === "input_error" && /Not a file/.test(err.message)
  );
  const text = writeTmp("fake.png", Buffer.from("this is not image data at all"));
  await assert.rejects(
    loadImageSource({ type: "file", value: text }, LIMITS),
    (err) => err.code === "input_error" && /not a supported image/.test(err.message)
  );
});

test("file source enforces maxImageBytes", async () => {
  const big = writeTmp("big.png", Buffer.concat([PNG, Buffer.alloc(2048)]));
  await assert.rejects(
    loadImageSource({ type: "file", value: big }, LIMITS),
    (err) => err.code === "input_error" && /maxImageBytes/.test(err.message)
  );
});

test("rejects malformed sources", async () => {
  await assert.rejects(loadImageSource(null, LIMITS), /image_source/);
  await assert.rejects(loadImageSource({ type: "glob", value: "*.png" }, LIMITS), /Unsupported/);
  await assert.rejects(loadImageSource({ type: "file", value: "  " }, LIMITS), /image_source/);
});

// --- URL tests against a local HTTP server (public/intranet/localhost are all
// allowed by design; protection is timeout/size/decode only). ---

const server = http.createServer((req, res) => {
  if (req.url === "/ok.png") {
    res.writeHead(200, { "content-type": "image/png" });
    res.end(PNG);
  } else if (req.url === "/hop1") {
    res.writeHead(302, { location: "/hop2" });
    res.end();
  } else if (req.url === "/hop2") {
    res.writeHead(302, { location: "/ok.png" });
    res.end();
  } else if (req.url === "/loop") {
    res.writeHead(302, { location: "/loop" });
    res.end();
  } else if (req.url === "/huge-declared") {
    res.writeHead(200, { "content-type": "image/png", "content-length": String(10 * 1024) });
    res.end(Buffer.concat([PNG, Buffer.alloc(10 * 1024 - PNG.length)]));
  } else if (req.url === "/huge-streamed") {
    res.writeHead(200, { "content-type": "image/png" });
    res.end(Buffer.concat([PNG, Buffer.alloc(10 * 1024)]));
  } else if (req.url === "/not-image") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html>hello</html>");
  } else if (req.url === "/slow") {
    // Never respond; exercises the timeout path.
  } else if (req.url === "/slow-body") {
    res.writeHead(200, { "content-type": "image/png" });
    res.write(PNG.subarray(0, 12));
  } else if (req.url === "/bad-redirect") {
    res.writeHead(302, { location: "file:///etc/passwd" });
    res.end();
  } else {
    res.writeHead(404);
    res.end("not found");
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

test("url source downloads and validates an image", async () => {
  const result = await loadImageSource({ type: "url", value: `${base}/ok.png` }, LIMITS);
  assert.equal(result.mediaType, "image/png");
});

test("url source follows redirects up to the cap", async () => {
  const result = await loadImageSource({ type: "url", value: `${base}/hop1` }, LIMITS);
  assert.equal(result.mediaType, "image/png");
  await assert.rejects(
    loadImageSource({ type: "url", value: `${base}/loop` }, LIMITS),
    (err) => err.code === "fetch_error" && /redirects/.test(err.message)
  );
});

test("url source enforces size limits, image validation, and status errors", async () => {
  await assert.rejects(
    loadImageSource({ type: "url", value: `${base}/huge-declared` }, LIMITS),
    (err) => err.code === "input_error" && /maxImageBytes/.test(err.message)
  );
  await assert.rejects(
    loadImageSource({ type: "url", value: `${base}/huge-streamed` }, LIMITS),
    (err) => err.code === "input_error" && /maxImageBytes/.test(err.message)
  );
  await assert.rejects(
    loadImageSource({ type: "url", value: `${base}/not-image` }, LIMITS),
    (err) => err.code === "input_error" && /not a supported image/.test(err.message)
  );
  await assert.rejects(
    loadImageSource({ type: "url", value: `${base}/missing.png` }, LIMITS),
    (err) => err.code === "fetch_error" && /HTTP 404/.test(err.message)
  );
});

test("url source times out instead of hanging", async () => {
  await assert.rejects(
    loadImageSource({ type: "url", value: `${base}/slow` }, { maxImageBytes: 1024, timeoutMs: 200 }),
    (err) => err.code === "fetch_error" && /Timed out/.test(err.message)
  );
  await assert.rejects(
    loadImageSource({ type: "url", value: `${base}/slow-body` }, { maxImageBytes: 1024, timeoutMs: 200 }),
    (err) => err.code === "fetch_error" && /Timed out/.test(err.message)
  );
});

test("url source rejects redirects to non-http schemes", async () => {
  await assert.rejects(
    loadImageSource({ type: "url", value: `${base}/bad-redirect` }, LIMITS),
    (err) => err.code === "fetch_error" && /unsupported protocol/.test(err.message)
  );
});

test("url source rejects non-http schemes", async () => {
  await assert.rejects(
    loadImageSource({ type: "url", value: "ftp://example.com/a.png" }, LIMITS),
    /http\(s\)/
  );
});
