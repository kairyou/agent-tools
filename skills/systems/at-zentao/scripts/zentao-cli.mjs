#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const JSON_LIMIT = 4 * 1024 * 1024;
const BINARY_LIMIT = 20 * 1024 * 1024;
const INPUT_LIMIT = 1024 * 1024;
// Keep write-back guidance compact enough to remain useful in an agent response.
const COMMENT_PROMPT_LIMIT = 1000;
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
  const rawCommentPrompt = section.commentPrompt;
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
  if (rawCommentPrompt !== undefined && typeof rawCommentPrompt !== "string") {
    throw new CliError("config_error", "zentao.commentPrompt must be a string");
  }
  const commentPrompt = rawCommentPrompt?.trim() || null;
  if (commentPrompt && commentPrompt.length > COMMENT_PROMPT_LIMIT) {
    throw new CliError(
      "config_error",
      `zentao.commentPrompt must not exceed ${COMMENT_PROMPT_LIMIT} characters`
    );
  }
  return {
    url: parsedUrl.href.replace(/\/$/, ""),
    account,
    password,
    token,
    tokenOnly: Boolean(token),
    commentPrompt,
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

// ZenTao 经典 action 写操作可能返回 `<html>...</script>\n{...json...}`, 取最后一个 </script> 后的 JSON 重试解析.
function unwrapHtmlWrappedJson(body) {
  const marker = "</script>";
  if (!body.includes(marker)) return body;
  const idx = body.lastIndexOf(marker);
  const candidate = body.slice(idx + marker.length).trim();
  return candidate || body;
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
      const unwrapped = unwrapHtmlWrappedJson(body);
      if (unwrapped !== body) {
        try {
          return JSON.parse(unwrapped);
        } catch {
          // 剥掉包装后仍无效, 走下方统一报错
        }
      }
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

function detailKind(value) {
  if (value !== "bug" && value !== "task" && value !== "story") {
    throw new CliError("usage_error", "detail type must be bug, task, or story");
  }
  return value;
}

function pick(source, keys) {
  const output = {};
  for (const key of keys) if (source?.[key] !== undefined) output[key] = source[key];
  return output;
}

function normalizeComments(actions) {
  const entries = Array.isArray(actions) ? actions : Object.values(actions || {});
  const comments = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || typeof entry.comment !== "string") continue;
    const comment = entry.comment.trim();
    if (!comment) continue;
    const output = {};
    for (const key of ["id", "actor", "action", "date"]) {
      if (typeof entry[key] === "string" || typeof entry[key] === "number") output[key] = entry[key];
    }
    output.comment = comment;
    comments.push(output);
  }
  return comments;
}

function normalizeDetail(kind, response) {
  const container = response?.data && typeof response.data === "object" ? response.data : response;
  const detail = container?.[kind] || container;
  if (!detail || typeof detail !== "object") {
    throw new CliError("response_error", `ZenTao response has no ${kind} detail`);
  }
  const fields = [
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
    "story",
    "type",
    "openedDate",
    "deadline",
  ];
  if (kind === "task") {
    fields.push("estimate", "consumed", "left", "realStarted", "finishedDate");
  } else if (kind === "story") {
    fields.push("stage", "category", "plan", "estimate", "spec", "verify", "source", "sourceNote");
  }
  const safe = pick(detail, fields);
  const actions = detail.actions ?? container?.actions;
  if ((kind === "bug" || kind === "task") && actions && typeof actions === "object") {
    safe.comments = normalizeComments(actions);
  }
  return { raw: detail, safe };
}

function attachmentUrls(detail) {
  const found = new Set();
  const html = [detail.steps, detail.desc, detail.spec, detail.verify]
    .filter((entry) => typeof entry === "string")
    .join("\n");
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

function formBody(fields, includeEmpty = []) {
  const body = new URLSearchParams();
  const keepEmpty = new Set(includeEmpty);
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null && (value !== "" || keepEmpty.has(key))) {
      body.set(key, String(value));
    }
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

async function workhourVariant(client, id) {
  const variants = [
    { route: `task-recordworkhour-${id}.json`, dateField: "date[1]", legacy: false },
    { route: `task-recordestimate-${id}.json`, dateField: "dates[1]", legacy: true },
  ];
  for (const variant of variants) {
    try {
      const form = decodeLegacy(await client.json(variant.route));
      return { ...variant, form };
    } catch (error) {
      const unavailable = error instanceof CliError && (
        (error.code === "http_error" && error.status === 404) ||
        error.code === "response_error"
      );
      if (!unavailable) throw error;
    }
  }
  throw new CliError(
    "unsupported_version",
    "ZenTao exposes neither recordWorkhour nor recordEstimate for this task"
  );
}

function effortRecords(form) {
  const candidates = [
    form?.efforts,
    form?.estimates,
    form?.workhours,
    form?.taskEfforts,
    form?.task?.efforts,
    form?.task?.estimates,
  ];
  const collection = candidates.find((value) => value && typeof value === "object");
  if (!collection) return [];
  const entries = Array.isArray(collection)
    ? collection.map((value) => [null, value])
    : Object.entries(collection);
  const records = entries
    .filter(([, value]) => value && typeof value === "object")
    .map(([key, value]) => ({
      ...(value.id === undefined && /^\d+$/.test(key || "") ? { id: Number(key) } : {}),
      ...pick(value, ["id", "date", "consumed", "left", "work"]),
    }));
  return records;
}

function effortFromEditForm(form) {
  const effort = form?.effort || form?.estimate || form?.workhour ||
    (form?.id !== undefined ? form : null);
  if (!effort || typeof effort !== "object") {
    throw new CliError("response_error", "ZenTao returned no editable work-hour record");
  }
  return effort;
}

function verifyEffortTask(effort, taskId) {
  if (effort.objectType !== undefined && effort.objectType !== "task") {
    throw new CliError("ownership_error", "The work-hour record does not belong to a task");
  }
  const owner = effort.objectID ?? effort.task ?? effort.taskID;
  if (owner === undefined || String(owner) !== String(taskId)) {
    throw new CliError("ownership_error", "The work-hour record does not belong to the requested task");
  }
}

async function editableEffortVariant(client, effortId) {
  const variants = [
    { route: `task-editeffort-${effortId}.json`, legacy: false },
    { route: `task-editestimate-${effortId}.json`, legacy: true },
  ];
  for (const variant of variants) {
    try {
      const form = decodeLegacy(await client.json(variant.route));
      return { ...variant, effort: effortFromEditForm(form) };
    } catch (error) {
      const unavailable = error instanceof CliError && (
        (error.code === "http_error" && error.status === 404) ||
        error.code === "response_error"
      );
      if (!unavailable) throw error;
    }
  }
  throw new CliError(
    "unsupported_version",
    "ZenTao exposes neither editEffort nor editEstimate for this work-hour record"
  );
}

function effortFields(effort, input) {
  const date = effortDate(input.date ?? effort.date);
  const consumed = Number(input.consumed ?? effort.consumed);
  const left = Number(input.left ?? effort.left);
  const work = input.work ?? effort.work ?? "";
  if (!Number.isFinite(consumed) || consumed <= 0) {
    throw new CliError("usage_error", "consumed must be positive");
  }
  if (!Number.isFinite(left) || left < 0) {
    throw new CliError("usage_error", "left must be zero or positive");
  }
  if (typeof work !== "string") {
    throw new CliError("usage_error", "work must be a string");
  }
  return { date, consumed, left, work: work.trim() };
}

function localDateTime(date = new Date()) {
  const part = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())} ${part(date.getHours())}:${part(date.getMinutes())}:${part(date.getSeconds())}`;
}

function localDate(date = new Date()) {
  return localDateTime(date).slice(0, 10);
}

function effortDate(value) {
  const date = value === undefined ? localDate() : value;
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new CliError("usage_error", "date must use YYYY-MM-DD");
  }
  const [year, month, day] = date.split("-").map(Number);
  const parsed = new Date(year, month - 1, day);
  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    throw new CliError("usage_error", "date must be a valid calendar date");
  }
  if (date > localDate()) throw new CliError("usage_error", "date cannot be in the future");
  return date;
}

function help() {
  return `Usage:
  zentao-cli.mjs doctor
  zentao-cli.mjs list <bugs|tasks>
  zentao-cli.mjs get <bug|task|story> <id> [--download-dir <path>]
  zentao-cli.mjs resolve bug <id>          # JSON on stdin
  zentao-cli.mjs comment <bug|task> <id>   # {"comment":"..."} on stdin
  zentao-cli.mjs start task <id>           # JSON on stdin
  zentao-cli.mjs pause task <id>           # JSON on stdin
  zentao-cli.mjs resume task <id>          # JSON on stdin
  zentao-cli.mjs hours task <id>
  zentao-cli.mjs log-hours task <id>       # JSON on stdin
  zentao-cli.mjs edit-hours task <id> <effort-id> # JSON on stdin
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
      ? ["id", "title", "severity", "pri", "status", "project", "product", "story"]
      : ["id", "name", "title", "pri", "status", "project", "execution", "module", "story", "estimate", "consumed", "left", "realStarted", "finishedDate"];
    const items = Array.isArray(data?.[plural]) ? data[plural].map((item) => pick(item, fields)) : [];
    return { items, ...(data?.pager ? { pager: pick(data.pager, ["recTotal", "recPerPage", "pageID", "pageTotal"]) } : {}) };
  }

  if (command === "get") {
    const kind = detailKind(args[0]);
    const id = positiveId(args[1]);
    let directory;
    if (args[2] === "--download-dir" && args[3]) directory = path.resolve(args[3]);
    else if (args.length > 2) throw new CliError("usage_error", "get accepts only --download-dir <path>");
    else directory = fs.mkdtempSync(path.join(os.tmpdir(), `agent-tools-zentao-${kind}-${id}-`));
    const resource = kind === "story" ? "stories" : `${kind}s`;
    const detail = normalizeDetail(kind, await client.json(`api.php/v1/${resource}/${id}`));
    const attachments = await downloadAttachments(client, detail.raw, directory);
    return {
      item: detail.safe,
      attachments,
      ...(kind !== "story" && config.commentPrompt
        ? { writeback: { commentPrompt: config.commentPrompt } }
        : {}),
    };
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

  if (["start", "pause", "resume"].includes(command)) {
    if (args[0] !== "task") throw new CliError("usage_error", `${command} supports tasks only`);
    const id = positiveId(args[1]);
    const input = await readInput();
    if (input.comment !== undefined && typeof input.comment !== "string") {
      throw new CliError("usage_error", "comment must be a string when provided");
    }
    if (input.realStarted !== undefined && (
      command !== "start" ||
      typeof input.realStarted !== "string" ||
      !input.realStarted.trim()
    )) {
      throw new CliError("usage_error", "realStarted is accepted only for start and must be a non-empty string");
    }

    const method = command === "resume" ? "restart" : command;
    const route = `task-${method}-${id}.json`;
    const form = decodeLegacy(await client.json(route));
    const task = form?.task || form;
    const fields = { comment: input.comment?.trim() };

    if (command !== "pause") {
      const consumed = Number(task?.consumed);
      const left = Number(task?.left);
      if (!Number.isFinite(consumed) || consumed < 0 || !Number.isFinite(left) || left <= 0) {
        throw new CliError("response_error", "ZenTao task has no safe current consumed/left values for this transition");
      }
      const assignedTo = typeof task.assignedTo === "string" && task.assignedTo
        ? task.assignedTo
        : config.account;
      const existingStarted = typeof task.realStarted === "string" &&
        task.realStarted.trim() &&
        !task.realStarted.startsWith("0000-00-00")
        ? task.realStarted
        : null;
      Object.assign(fields, {
        assignedTo,
        consumed,
        left,
        realStarted: command === "start"
          ? input.realStarted?.trim() || localDateTime()
          : existingStarted || localDateTime(),
      });
    }

    const response = await client.json(route, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: formBody(fields),
    });
    return legacyResult(response);
  }

  if (command === "log-hours") {
    if (args[0] !== "task") throw new CliError("usage_error", "log-hours supports tasks only");
    const id = positiveId(args[1]);
    const input = await readInput();
    const consumed = Number(input.consumed);
    const left = Number(input.left);
    if (!Number.isFinite(consumed) || consumed <= 0) {
      throw new CliError("usage_error", "consumed must be positive");
    }
    if (!Number.isFinite(left) || left <= 0) {
      throw new CliError("usage_error", "left must be positive; use finish to complete a task");
    }
    if (input.work !== undefined && typeof input.work !== "string") {
      throw new CliError("usage_error", "work must be a string when provided");
    }
    const date = effortDate(input.date);
    const variant = await workhourVariant(client, id);
    const fields = {
      [variant.dateField]: date,
      "work[1]": input.work?.trim(),
      "consumed[1]": consumed,
      "left[1]": left,
    };
    if (variant.legacy) fields["id[1]"] = 1;
    const response = await client.json(variant.route, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: formBody(fields),
    });
    return legacyResult(response);
  }

  if (command === "hours") {
    if (args[0] !== "task") throw new CliError("usage_error", "hours supports tasks only");
    const id = positiveId(args[1]);
    const variant = await workhourVariant(client, id);
    return { records: effortRecords(variant.form) };
  }

  if (command === "edit-hours") {
    if (args[0] !== "task") throw new CliError("usage_error", "edit-hours supports tasks only");
    const taskId = positiveId(args[1]);
    const effortId = positiveId(args[2]);
    const input = await readInput();
    const allowed = ["date", "consumed", "left", "work"];
    if (!allowed.some((field) => Object.hasOwn(input, field))) {
      throw new CliError("usage_error", "at least one work-hour field is required");
    }
    if (input.work !== undefined && typeof input.work !== "string") {
      throw new CliError("usage_error", "work must be a string when provided");
    }
    const variant = await editableEffortVariant(client, effortId);
    verifyEffortTask(variant.effort, taskId);
    const fields = effortFields(variant.effort, input);
    const response = await client.json(variant.route, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: formBody(fields, ["work"]),
    });
    return legacyResult(response);
  }

  if (command === "finish") {
    if (args[0] !== "task") throw new CliError("usage_error", "finish supports tasks only");
    const id = positiveId(args[1]);
    const input = await readInput();
    const current = Number(input.currentConsumed);
    if (!Number.isFinite(current) || current <= 0) throw new CliError("usage_error", "currentConsumed must be positive");
    if (input.comment !== undefined && typeof input.comment !== "string") {
      throw new CliError("usage_error", "comment must be a string when provided");
    }
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
        comment: input.comment?.trim(),
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
