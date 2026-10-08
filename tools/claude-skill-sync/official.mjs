import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractOfficialSkills } from "./bundle.mjs";

export const OFFICIAL_PACKAGE = "@anthropic-ai/claude-code-linux-x64";
const hash = (data) => createHash("sha256").update(data).digest("hex");
// Native packages include the runtime. Bound download and tar output above the
// verified ~250 MiB package size, without a host-dependent installation.
const MAX_PACKAGE_BYTES = 512 * 1024 * 1024;

async function download(url, limit) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error(`Official package response exceeds ${limit} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function fetchOfficialSnapshot(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid official version: ${version}`);
  const metadata = JSON.parse(await download(`https://registry.npmjs.org/${OFFICIAL_PACKAGE}/${version}`, 1024 * 1024));
  if (metadata.name !== OFFICIAL_PACKAGE || metadata.version !== version) throw new Error("Official package version mismatch");
  const url = new URL(metadata.dist.tarball);
  if (url.origin !== "https://registry.npmjs.org") throw new Error("Unexpected official tarball host");
  const integrity = /^sha512-([A-Za-z0-9+/=]+)$/.exec(metadata.dist.integrity || "");
  if (!integrity) throw new Error("Official package has no SHA-512 integrity");
  const archive = await download(url.href, MAX_PACKAGE_BYTES);
  if (createHash("sha512").update(archive).digest("base64") !== integrity[1]) throw new Error("Official package integrity mismatch");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "claude-skill-official-"));
  try {
    fs.writeFileSync(path.join(directory, "package.tgz"), archive);
    // Read a single known member to stdout. No installation, execution, or
    // filesystem extraction of the upstream archive is performed.
    const bundle = execFileSync("tar", ["-xOf", "package.tgz", "package/claude"], {
      cwd: directory, maxBuffer: MAX_PACKAGE_BYTES, windowsHide: true,
    });
    return {
      schemaVersion: 3,
      claudeCodeVersion: version,
      source: {
        package: OFFICIAL_PACKAGE, version, tarball: url.href,
        integrity: metadata.dist.integrity, bundleSha256: hash(bundle),
      },
      ...extractOfficialSkills(bundle),
    };
  } finally {
    const relative = path.relative(os.tmpdir(), directory);
    if (path.isAbsolute(relative) || relative.startsWith("..") || !relative.startsWith("claude-skill-official-")) {
      throw new Error("Refusing cleanup outside the official-package temporary directory");
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
