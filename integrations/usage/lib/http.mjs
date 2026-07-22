// JSON-over-HTTP requests to gateways, including the anti-bot shield
// challenge some NewAPI deployments serve before the real response.

import { createContext, runInContext } from "node:vm";
import { debugLog } from "./config.mjs";

const REQUEST_TIMEOUT_MS = 5000;
const SHIELD_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36";

function shortPreview(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

function isShieldChallenge(contentType, text) {
  const normalizedType = String(contentType || "").toLowerCase();
  return (
    (normalizedType.includes("text/html") && /var\s+arg1\s*=|acw_sc__v2|cdn_sec_tc|<script/i.test(text)) ||
    /var\s+arg1\s*=/.test(text)
  );
}

function parseChallengeArg1(html) {
  const match = String(html).match(/var\s+arg1\s*=\s*['"]([0-9a-fA-F]+)['"]/);
  return match?.[1]?.toUpperCase() || "";
}

function parseChallengeMapping(html) {
  const match = String(html).match(/for\(var m=\[([^\]]+)\],p=L\(0x115\)/);
  if (!match?.[1]) return null;
  const values = match[1].split(",").map((raw) => {
    const value = raw.trim().toLowerCase();
    if (!value) return Number.NaN;
    return value.startsWith("0x") ? Number.parseInt(value.slice(2), 16) : Number.parseInt(value, 10);
  });
  return values.some((value) => Number.isNaN(value)) ? null : values;
}

function parseChallengeXorSeed(html) {
  const text = String(html);
  const fnStart = text.indexOf("function a0i()");
  const bStart = text.indexOf("function b(");
  const rotateStart = text.indexOf("(function(a,c){");
  const rotateEnd = text.indexOf("),!(function", rotateStart);
  if (fnStart < 0 || bStart < 0 || bStart <= fnStart || rotateStart < 0 || rotateEnd < 0) {
    return "";
  }

  const helperCode = text.slice(fnStart, bStart);
  const rotateCode = `${text.slice(rotateStart, rotateEnd + 1)})`;
  try {
    const sandbox = { decodeURIComponent };
    createContext(sandbox);
    runInContext(helperCode, sandbox, { timeout: 100 });
    runInContext(rotateCode, sandbox, { timeout: 100 });
    const decoder = sandbox.a0j;
    if (typeof decoder !== "function") return "";
    const seed = decoder(0x115);
    return typeof seed === "string" && /^[0-9a-f]+$/i.test(seed) ? seed : "";
  } catch {
    return "";
  }
}

function solveNewApiAcwScV2(html) {
  const arg1 = parseChallengeArg1(html);
  const mapping = parseChallengeMapping(html);
  const xorSeed = parseChallengeXorSeed(html);
  if (!arg1 || !mapping || !xorSeed) return "";

  const reordered = [];
  for (let i = 0; i < arg1.length; i += 1) {
    const ch = arg1[i];
    for (let j = 0; j < mapping.length; j += 1) {
      if (mapping[j] === i + 1) reordered[j] = ch;
    }
  }

  const source = reordered.join("");
  let out = "";
  for (let i = 0; i < source.length && i < xorSeed.length; i += 2) {
    const left = Number.parseInt(source.slice(i, i + 2), 16);
    const right = Number.parseInt(xorSeed.slice(i, i + 2), 16);
    if (Number.isNaN(left) || Number.isNaN(right)) return "";
    out += (left ^ right).toString(16).padStart(2, "0");
  }
  return out;
}

function upsertCookie(cookieHeader, name, value) {
  const parts = String(cookieHeader || "").split(";").map((part) => part.trim()).filter(Boolean);
  let replaced = false;
  const next = parts.map((part) => {
    const eq = part.indexOf("=");
    if (eq < 0) return part;
    const key = part.slice(0, eq).trim();
    if (key !== name) return part;
    replaced = true;
    return `${name}=${value}`;
  });
  if (!replaced) next.push(`${name}=${value}`);
  return next.join("; ");
}

function collectSetCookieHeaders(headers) {
  const getSetCookie = headers?.getSetCookie;
  if (typeof getSetCookie === "function") return getSetCookie.call(headers) || [];
  const single = headers?.get?.("set-cookie");
  return single ? [single] : [];
}

function mergeSetCookiePairs(cookieHeader, setCookieHeaders) {
  let merged = cookieHeader || "";
  for (const raw of setCookieHeaders || []) {
    const firstPair = String(raw || "").split(";")[0]?.trim();
    if (!firstPair) continue;
    const eq = firstPair.indexOf("=");
    if (eq <= 0) continue;
    merged = upsertCookie(merged, firstPair.slice(0, eq).trim(), firstPair.slice(eq + 1));
  }
  return merged;
}

export async function requestJson(url, options = {}) {
  const { key = "", headers = {}, name = "usage", timeoutMs = REQUEST_TIMEOUT_MS } = options;
  let cookieHeader = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        "user-agent": SHIELD_USER_AGENT,
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
        ...headers,
      },
      signal: controller.signal,
    });

    try {
      const body = await response.text();
      cookieHeader = mergeSetCookiePairs(cookieHeader, collectSetCookieHeaders(response.headers));
      let json = {};
      try {
        json = body ? JSON.parse(body) : {};
      } catch {
        const contentType = response.headers.get("content-type") || "";
        const acwScV2 = isShieldChallenge(contentType, body) ? solveNewApiAcwScV2(body) : "";
        await debugLog({
          source: name,
          url,
          status: response.status,
          contentType,
          shieldRetry: Boolean(acwScV2 && attempt === 0),
          bodyPreview: shortPreview(body),
        });
        if (acwScV2 && attempt === 0) {
          cookieHeader = upsertCookie(cookieHeader, "acw_sc__v2", acwScV2);
          continue;
        }
        throw new Error(`${name} returned non-JSON (${response.status})`);
      }

      if (!response.ok) {
        const message = json?.error?.message || json?.message || response.statusText;
        await debugLog({
          source: name,
          url,
          status: response.status,
          message,
          bodyPreview: shortPreview(body),
        });
        throw new Error(`${name} failed (${response.status} ${message})`);
      }

      return json;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(`${name} unavailable`);
}
