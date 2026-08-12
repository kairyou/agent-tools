#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const JSON_LIMIT = 4 * 1024 * 1024;
const BINARY_LIMIT = 20 * 1024 * 1024;
const INPUT_LIMIT = 1024 * 1024;
const SECRET_KEYS = /^(?:password|token|authorization|cookie|set-cookie)$/i;
const RESOLUTIONS = new Set([
  "fixed",
  "notrepro",
  "duplicate",
  "bydesign",
  "external",
  "postponed",
  "willnotfix",
]);
let activeSecrets = [];

class CliError extends Error {
  constructor(code, message, status = null) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function stripJsonc(text) {
  let output = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (lineComment) {
      if (char === "\n" || char === "\r") {
        lineComment = false;
        output += char;
      } else {
        output += " ";
      }
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        output += "  ";
        index += 1;
        blockComment = false;
      } else {
        output += char === "\n" || char === "\r" ? char : " ";
      }
      continue;
    }
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
    } else if (char === "/" && next === "/") {
      output += "  ";
      index += 1;
      lineComment = true;
    } else if (char === "/" && next === "*") {
      output += "  ";
      index += 1;
      blockComment = true;
    } else {
      output += char;
    }
  }

  let cleaned = "";
  inString = false;
  escaped = false;
  for (let index = 0; index < output.length; index += 1) {
    const char = output[index];
    if (inString) {
      cleaned += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      cleaned += char;
      continue;
    }
    if (char === ",") {
      let lookahead = index + 1;
      while (/\s/.test(output[lookahead] || "")) lookahead += 1;
      if (output[lookahead] === "}" || output[lookahead] === "]") continue;
    }
    cleaned += char;
  }
  return cleaned;
}

export function parseJsonc(text, label = "config") {
  try {
    return JSON.parse(stripJsonc(text));
  } catch {
    throw new CliError("config_error", `${label} is not valid JSONC`);
  }
}

function configFile(env) {
  const root = env.AGENT_TOOLS_HOME
    ? path.resolve(env.AGENT_TOOLS_HOME)
    : path.join(os.homedir(), ".agent-tools");
  return path.join(root, "config.jsonc");
}

function resolveValue(value, env, label, { required = true } = {}) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.env === "string" &&
    value.env.trim()
  ) {
    const name = value.env.trim();
    if (typeof env[name] === "string" && env[name].trim()) return env[name].trim();
    throw new CliError("config_error", `${label} references unset environment variable ${name}`);
  }
  if (!required && (value === undefined || value === null || value === "")) return null;
  throw new CliError("config_error", `${label} is missing or empty`);
}

export function loadConfig({ env = process.env, file = configFile(env) } = {}) {
  let root = {};
  if (fs.existsSync(file)) root = parseJsonc(fs.readFileSync(file, "utf8"), file);
  const section = root.zentao && typeof root.zentao === "object" ? root.zentao : {};
  const rawUrl = env.ZENTAO_URL || section.url;
  const rawAccount = env.ZENTAO_ACCOUNT || section.account;
  const rawPassword = env.ZENTAO_PASSWORD || section.password;
  const rawToken = env.ZENTAO_TOKEN;
  const urlText = resolveValue(rawUrl, env, "zentao.url");
  let parsedUrl;
  try {
    parsedUrl = new URL(urlText);
  } catch {
    throw new CliError("config_error", "zentao.url must be a valid HTTP(S) URL");
  }
  if (
    !["http:", "https:"].includes(parsedUrl.protocol) ||
    parsedUrl.username ||
    parsedUrl.password ||
    parsedUrl.search ||
    parsedUrl.hash
  ) {
    throw new CliError(
      "config_error",
      "zentao.url must be an HTTP(S) URL without credentials, query, or fragment"
    );
  }
  parsedUrl.pathname = parsedUrl.pathname.replace(/\/+$/, "");
  const token = resolveValue(rawToken, env, "zentao.token", { required: false });
  const account = resolveValue(rawAccount, env, "zentao.account", { required: !token });
  const password = resolveValue(rawPassword, env, "zentao.password", { required: !token });
  return {
    url: parsedUrl.href.replace(/\/$/, ""),
    account,
    password,
    token,
    tokenOnly: Boolean(token),
    secrets: [account, password, token].filter(Boolean),
  };
}

function redactString(value, secrets) {
  let output = value;
  for (const secret of secrets) output = output.split(secret).join("***");
  return output;
}

export function sanitize(value, secrets = []) {
  if (typeof value === "string") return redactString(value, secrets);
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry, secrets));
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = SECRET_KEYS.test(key) ? "***" : sanitize(entry, secrets);
    }
    return output;
  }
  return value;
}

async function readLimited(response, limit) {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new CliError("response_too_large", `ZenTao response exceeds ${limit} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function safeRemoteMessage(body, secrets) {
  let value;
  try {
    value = JSON.parse(body);
  } catch {
    value = null;
  }
  const candidates = [value?.message, value?.error, value?.msg].filter(
    (entry) => typeof entry === "string" && entry.trim()
  );
  const message = candidates[0] || "ZenTao returned an error response";
  return redactString(message.slice(0, 500), secrets);
}

class ZenTaoClient {
  constructor(config) {
    this.config = config;
    this.token = config.token;
  }

  endpoint(relative) {
    const url = new URL(relative, `${this.config.url}/`);
    const base = new URL(this.config.url);
    if (url.origin !== base.origin || !url.pathname.startsWith(`${base.pathname.replace(/\/$/, "")}/`)) {
      throw new CliError("unsafe_url", "ZenTao resource URL is outside the configured endpoint");
    }
    return url;
  }

  async exchangeToken() {
    if (this.config.tokenOnly) return this.token;
    const response = await fetch(this.endpoint("api.php/v1/tokens"), {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account: this.config.account, password: this.config.password }),
    });
    const body = (await readLimited(response, JSON_LIMIT)).toString("utf8");
    if (!response.ok) {
      throw new CliError(
        "auth_error",
        `ZenTao authentication failed (HTTP ${response.status})`,
        response.status
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new CliError("auth_error", "ZenTao authentication returned invalid JSON");
    }
    if (typeof parsed.token !== "string" || !parsed.token) {
      throw new CliError("auth_error", "ZenTao authentication response has no token");
    }
    this.token = parsed.token;
    this.config.secrets.push(parsed.token);
    return this.token;
  }

  async request(relative, options = {}, retried = false) {
    if (!this.token) await this.exchangeToken();
    const headers = new Headers(options.headers || {});
    headers.set("Token", this.token);
    const response = await fetch(this.endpoint(relative), {
      ...options,
      headers,
      redirect: "manual",
    });
    if (response.status === 401 && !retried && !this.config.tokenOnly) {
      await response.body?.cancel();
      this.token = null;
      await this.exchangeToken();
      return this.request(relative, options, true);
    }
    return response;
  }

  async json(relative, options = {}) {
    const response = await this.request(relative, options);
    const body = (await readLimited(response, JSON_LIMIT)).toString("utf8");
    if (!response.ok) {
      throw new CliError(
        response.status === 401 ? "auth_error" : "http_error",
        `ZenTao request failed (HTTP ${response.status}): ${safeRemoteMessage(body, this.config.secrets)}`,
        response.status
      );
    }
    try {
      return JSON.parse(body);
    } catch {
      throw new CliError("response_error", "ZenTao returned invalid JSON");
    }
  }

  async download(relative, destination) {
    const response = await this.request(relative);
    if (!response.ok) {
      const body = (await readLimited(response, JSON_LIMIT)).toString("utf8");
      throw new CliError(
        "http_error",
        `ZenTao attachment failed (HTTP ${response.status}): ${safeRemoteMessage(body, this.config.secrets)}`,
        response.status
      );
    }
    const body = await readLimited(response, BINARY_LIMIT);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, body, { flag: "wx" });
  }
}

function decodeLegacy(value) {
  if (!value || typeof value !== "object") throw new CliError("response_error", "ZenTao returned an invalid response");
  if (value.status && value.status !== "success") {
    throw new CliError("remote_error", "ZenTao reported that the operation failed");
  }
  if (typeof value.data !== "string") return value.data ?? value;
  try {
    return JSON.parse(value.data);
  } catch {
    throw new CliError("response_error", "ZenTao returned invalid nested JSON");
  }
}

function positiveId(value) {
  if (!/^\d+$/.test(value || "") || Number(value) < 1) {
    throw new CliError("usage_error", "item id must be a positive integer");
  }
  return value;
}

function itemKind(value) {
  if (value !== "bug" && value !== "task") {
    throw new CliError("usage_error", "item type must be bug or task");
  }
  return value;
}

function pick(source, keys) {
  const output = {};
  for (const key of keys) if (source?.[key] !== undefined) output[key] = source[key];
  return output;
}

function normalizeDetail(kind, response) {
  const container = response?.data && typeof response.data === "object" ? response.data : response;
  const detail = container?.[kind] || container;
  if (!detail || typeof detail !== "object") {
    throw new CliError("response_error", `ZenTao response has no ${kind} detail`);
  }
  return { raw: detail, safe: pick(detail, [
    "id",
    "title",
    "name",
    "steps",
    "desc",
    "status",
    "severity",
    "pri",
    "module",
    "product",
    "project",
    "execution",
    "type",
    "openedDate",
    "deadline",
  ]) };
}

function attachmentUrls(detail) {
  const found = new Set();
  const html = [detail.steps, detail.desc].filter((entry) => typeof entry === "string").join("\n");
  for (const match of html.matchAll(/(?:src|href)=["']([^"']*\/file-(?:read|download)-\d+[^"']*)["']/gi)) {
    found.add(match[1].replaceAll("&amp;", "&"));
  }
  const files = Array.isArray(detail.files) ? detail.files : Object.values(detail.files || {});
  for (const file of files) {
    for (const key of ["url", "webPath", "downloadURL", "downloadUrl"]) {
      if (typeof file?.[key] === "string" && /\/file-(?:read|download)-\d+/i.test(file[key])) {
        found.add(file[key]);
        break;
      }
    }
  }
  return [...found];
}

function attachmentName(urlText, index) {
  const pathname = new URL(urlText, "http://placeholder").pathname;
  const match = pathname.match(/(file-(?:read|download)-\d+)(?:\.([A-Za-z0-9]{1,10}))?/i);
  if (!match) return `attachment-${index + 1}`;
  return `${match[1]}${match[2] ? `.${match[2]}` : ""}`;
}

async function downloadAttachments(client, detail, directory) {
  const output = [];
  for (const [index, urlText] of attachmentUrls(detail).entries()) {
    const url = client.endpoint(urlText);
    const destination = path.join(directory, attachmentName(url.href, index));
    await client.download(url.href, destination);
    output.push({ path: path.resolve(destination) });
  }
  return output;
}

async function readInput() {
  if (process.stdin.isTTY) throw new CliError("usage_error", "this command requires JSON on stdin");
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > INPUT_LIMIT) throw new CliError("usage_error", "stdin JSON is too large");
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new CliError("usage_error", "stdin must contain valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CliError("usage_error", "stdin JSON must be an object");
  }
  return value;
}

function formBody(fields) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null && value !== "") body.set(key, String(value));
  }
  return body;
}

function legacyResult(response) {
  const data = decodeLegacy(response);
  const result = data?.result || data?.status || "success";
  const message = data?.message || data?.msg || null;
  if (result === "fail" || result === "failed" || result === "error") {
    throw new CliError("remote_validation_error", typeof message === "string" ? message.slice(0, 500) : "ZenTao rejected the operation");
  }
  return { ok: true, result, ...(typeof message === "string" ? { message: message.slice(0, 500) } : {}) };
}

function localDateTime(date = new Date()) {
  const part = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())} ${part(date.getHours())}:${part(date.getMinutes())}:${part(date.getSeconds())}`;
}

function help() {
  return `Usage:
  zentao-cli.mjs doctor
  zentao-cli.mjs list <bugs|tasks>
  zentao-cli.mjs get <bug|task> <id> [--download-dir <path>]
  zentao-cli.mjs resolve bug <id>          # JSON on stdin
  zentao-cli.mjs comment <bug|task> <id>   # {"comment":"..."} on stdin
  zentao-cli.mjs finish task <id>          # JSON on stdin`;
}

export async function run(argv, { env = process.env } = {}) {
  activeSecrets = [];
  const [command, ...args] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    return { help: help() };
  }
  const config = loadConfig({ env });
  activeSecrets = config.secrets;
  const client = new ZenTaoClient(config);

  if (command === "doctor") {
    await client.json("api.php/v1/user");
    return { ok: true, endpoint: new URL(config.url).origin, authentication: config.tokenOnly ? "token" : "account-password" };
  }

  if (command === "list") {
    const plural = args[0];
    if (plural !== "bugs" && plural !== "tasks") throw new CliError("usage_error", "list type must be bugs or tasks");
    const singular = plural.slice(0, -1);
    const data = decodeLegacy(await client.json(`my-work-${singular}.json`));
    const fields = singular === "bug"
      ? ["id", "title", "severity", "pri", "status", "project", "product"]
      : ["id", "name", "title", "pri", "status", "project", "execution", "module"];
    const items = Array.isArray(data?.[plural]) ? data[plural].map((item) => pick(item, fields)) : [];
    return { items, ...(data?.pager ? { pager: pick(data.pager, ["recTotal", "recPerPage", "pageID", "pageTotal"]) } : {}) };
  }

  if (command === "get") {
    const kind = itemKind(args[0]);
    const id = positiveId(args[1]);
    let directory;
    if (args[2] === "--download-dir" && args[3]) directory = path.resolve(args[3]);
    else if (args.length > 2) throw new CliError("usage_error", "get accepts only --download-dir <path>");
    else directory = fs.mkdtempSync(path.join(os.tmpdir(), `agent-tools-zentao-${kind}-${id}-`));
    const detail = normalizeDetail(kind, await client.json(`api.php/v1/${kind}s/${id}`));
    const attachments = await downloadAttachments(client, detail.raw, directory);
    return { item: detail.safe, attachments };
  }

  if (command === "comment") {
    const kind = itemKind(args[0]);
    const id = positiveId(args[1]);
    const input = await readInput();
    if (typeof input.comment !== "string" || !input.comment.trim()) throw new CliError("usage_error", "comment is required");
    const response = await client.json(`action-comment-${kind}-${id}.json`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: formBody({ comment: input.comment }),
    });
    return legacyResult(response);
  }

  if (command === "resolve") {
    if (args[0] !== "bug") throw new CliError("usage_error", "resolve supports bugs only");
    const id = positiveId(args[1]);
    if (!config.account) throw new CliError("config_error", "zentao.account is required to resolve a bug");
    const input = await readInput();
    if (!RESOLUTIONS.has(input.resolution)) throw new CliError("usage_error", "resolution is invalid");
    if (input.resolution === "duplicate" && !/^\d+$/.test(String(input.duplicateBug || ""))) {
      throw new CliError("usage_error", "duplicateBug is required for duplicate resolution");
    }
    const response = await client.json(`bug-resolve-${id}.json`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: formBody({
        resolution: input.resolution,
        resolvedBuild: input.resolvedBuild || "trunk",
        responsibleBy: config.account,
        duplicateBug: input.duplicateBug,
        comment: input.comment,
      }),
    });
    return legacyResult(response);
  }

  if (command === "finish") {
    if (args[0] !== "task") throw new CliError("usage_error", "finish supports tasks only");
    const id = positiveId(args[1]);
    const input = await readInput();
    const current = Number(input.currentConsumed);
    if (!Number.isFinite(current) || current <= 0) throw new CliError("usage_error", "currentConsumed must be positive");
    const form = decodeLegacy(await client.json(`task-finish-${id}.json`));
    const task = form?.task || {};
    const previous = Number(task.consumed || 0);
    const realStarted = task.realStarted || input.realStarted;
    if (typeof realStarted !== "string" || !realStarted.trim()) throw new CliError("usage_error", "realStarted is required");
    const response = await client.json(`task-finish-${id}.json`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: formBody({
        currentConsumed: current,
        consumed: previous + current,
        realStarted,
        finishedDate: input.finishedDate || localDateTime(),
      }),
    });
    return legacyResult(response);
  }

  throw new CliError("usage_error", `unknown command ${command}`);
}

async function main() {
  try {
    const result = await run(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(sanitize(result, activeSecrets), null, 2)}\n`);
  } catch (error) {
    const safe = sanitize({
      ok: false,
      error: error instanceof CliError ? error.code : "internal_error",
      message: error instanceof Error ? error.message : "Unknown ZenTao CLI error",
      ...(error instanceof CliError && error.status ? { status: error.status } : {}),
    }, activeSecrets);
    process.stderr.write(`${JSON.stringify(safe)}\n`);
    process.exitCode = 1;
  }
}

export function isMainModule(argvPath, moduleUrl = import.meta.url) {
  if (!argvPath) return false;
  try {
    return fs.realpathSync(argvPath) === fs.realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

const invoked = isMainModule(process.argv[1]);
if (invoked) await main();
