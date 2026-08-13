// Pure URL helpers for gateway base URLs and route cache keys.

export function isOfficialBaseUrl(baseUrl) {
  if (!baseUrl) return true;
  const clean = baseUrl.replace(/\/+$/, "");
  return [
    "https://api.openai.com",
    "https://api.openai.com/v1",
    "https://api.anthropic.com",
    "https://api.anthropic.com/v1",
  ].includes(clean);
}

export function cleanBaseUrl(baseUrl) {
  return String(baseUrl || "").replace(/\/+$/, "");
}

export function serviceRoot(baseUrl) {
  const clean = cleanBaseUrl(baseUrl);
  return clean.endsWith("/v1") ? clean.slice(0, -3) : clean;
}

export function usageRouteCacheKey(baseUrl) {
  try {
    const url = new URL(cleanBaseUrl(baseUrl));
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname
      .replace(/\/+$/, "")
      .replace(/\/api\/v1$/i, "")
      .replace(/\/v1$/i, "");
    return url.toString().replace(/\/$/, "");
  } catch {
    return serviceRoot(baseUrl);
  }
}

export function joinUrl(baseUrl, path) {
  return `${cleanBaseUrl(baseUrl)}${path.startsWith("/") ? path : `/${path}`}`;
}

export function hostIncludes(baseUrl, value) {
  try {
    return new URL(baseUrl).hostname.toLowerCase().includes(value);
  } catch {
    return false;
  }
}
