// Turns gateway payloads into the compact one-line usage message.

import { newApiQuotaScale, providerUsageDays, DEFAULT_NEW_API_QUOTA_SCALE } from "./config.mjs";

export function pickNumber(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

export function formatMoney(value) {
  return `$${value.toFixed(value >= 100 ? 0 : 1)}`;
}

function formatMaybeMoney(value, unit = "USD") {
  if (unit === "USD" || unit === "$") return formatMoney(value);
  return `${value.toLocaleString("en-US", { maximumFractionDigits: 1 })} ${unit}`;
}

function usageParts() {
  return ["API"];
}

async function formatNewApiQuota(value) {
  const scale = await newApiQuotaScale();
  if (Number.isFinite(scale) && scale > 0) return formatMoney(value / scale);
  return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

export function usageRoot(data) {
  return data?.data && typeof data.data === "object" ? data.data : data;
}

function shortDate(value) {
  if (!value) return "";
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[2]}-${match[3]}` : "";
}

function hasSubscriptionLimits(root) {
  const sub = root?.subscription || {};
  return [
    "daily_limit_usd",
    "weekly_limit_usd",
    "monthly_limit_usd",
    "daily_usage_usd",
    "weekly_usage_usd",
    "monthly_usage_usd",
  ].some((key) => pickNumber(sub, [key]) !== undefined);
}

function isQuotaLimitedUsage(root) {
  return root?.mode === "quota_limited" || root?.quota;
}

function isSubscriptionUsage(root) {
  return hasSubscriptionLimits(root) || (root?.mode === "unrestricted" && root?.subscription);
}

function isWalletUsage(root) {
  const planName = String(root?.planName || "");
  return (
    (root?.mode === "unrestricted" && !isSubscriptionUsage(root)) ||
    planName.includes("钱包") ||
    planName.toLowerCase().includes("wallet") ||
    (pickNumber(root, ["balance"]) !== undefined && !hasSubscriptionLimits(root))
  );
}

export function hasV1UsageFields(root) {
  return (
    hasSubscriptionLimits(root) ||
    pickNumber(root, [
      "balance",
      "remaining",
      "remain",
      "available",
      "hard_limit_usd",
      "hard_limit",
      "total_granted",
      "quota",
      "total_usage",
      "used",
      "usage",
    ]) !== undefined ||
    pickNumber(root?.quota, ["limit", "quota", "used", "quota_used", "remaining"]) !== undefined ||
    pickNumber(root?.usage?.today, ["actual_cost", "cost"]) !== undefined ||
    (Array.isArray(root?.daily_usage) && root.daily_usage.length > 0)
  );
}

export async function formatQuota(label, data) {
  const root = usageRoot(data);
  const unit = root?.unit || "USD";
  const remaining = pickNumber(root, ["remaining"]);
  const hardLimit = pickNumber(root, ["hard_limit_usd", "hard_limit", "total_granted", "quota"]);
  const used = pickNumber(root, ["total_usage", "used", "usage"]);
  const balance = pickNumber(root, ["balance", "remaining", "remain", "available"]);

  if (isQuotaLimitedUsage(root)) return formatQuotaLimitedLine(label, root);
  if (isSubscriptionUsage(root)) return formatUsageLine(label, root);
  if (isWalletUsage(root)) return await formatWalletLine(label, root);
  if (remaining !== undefined) return formatUsageLine(label, root);
  if (balance !== undefined) return `API | balance ${formatMaybeMoney(balance, unit)}`;
  if (hardLimit !== undefined && used !== undefined) {
    return `API | remaining ${formatMaybeMoney(Math.max(0, hardLimit - used), unit)}`;
  }
  if (hardLimit !== undefined) return `API | total ${formatMaybeMoney(hardLimit, unit)}`;

  const keys = Object.keys(root || {}).slice(0, 4).join(", ");
  return keys ? `API | received (${keys})` : `API | checked ${unit}`;
}

export async function formatNewApiTokenLine(label, data) {
  const root = usageRoot(data);
  const unlimited = root?.unlimited_quota === true || root?.unlimitedQuota === true;
  const quota = pickNumber(root, ["quota", "limit", "total_quota", "totalQuota"]);
  const used = pickNumber(root, ["used_quota", "usedQuota", "used"]);
  let remaining = pickNumber(root, ["remain_quota", "remainQuota", "remaining", "balance"]);
  if (remaining === undefined && quota !== undefined && used !== undefined) {
    remaining = Math.max(0, quota - used);
  }

  if (!unlimited && quota === undefined && used === undefined && remaining === undefined) {
    throw new Error("NewAPI token usage payload has no quota fields");
  }

  const parts = usageParts();
  if (unlimited) parts.push("unlimited");
  if (remaining !== undefined) parts.push(`balance ${await formatNewApiQuota(remaining)}`);
  if (used !== undefined && quota !== undefined) {
    parts.push(`used ${await formatNewApiQuota(used)}/${await formatNewApiQuota(quota)}`);
  } else if (used !== undefined) {
    parts.push(`used ${await formatNewApiQuota(used)}`);
  }
  return parts.join(" | ");
}

export function formatOpenRouterLine(label, data) {
  const root = usageRoot(data);
  const limit = pickNumber(root, ["limit", "limit_remaining", "total_credits"]);
  const remaining = pickNumber(root, ["limit_remaining", "remaining_credits"]);
  const used = pickNumber(root, ["usage", "total_usage", "spend"]);
  const reset = root?.limit_reset || root?.reset_at ? shortDate(root.limit_reset || root.reset_at) : "";
  const parts = usageParts();

  if (remaining !== undefined) parts.push(`balance ${formatMoney(remaining)}`);
  if (used !== undefined && limit !== undefined && limit !== remaining) {
    parts.push(`used ${formatMoney(used)}/${formatMoney(limit)}`);
  } else if (used !== undefined) {
    parts.push(`used ${formatMoney(used)}`);
  }
  if (reset) parts.push(`Reset ${reset}`);

  if (parts.length === 1) throw new Error("OpenRouter payload has no usage fields");
  return parts.join(" | ");
}

export function panelQuotaScale(kind) {
  return kind === "veloera" ? 1000000 : DEFAULT_NEW_API_QUOTA_SCALE;
}

export function panelQuotaLooksRemaining(kind) {
  return ["new-api", "anyrouter", "agentrouter", "done-hub", "donehub"].includes(kind);
}

export async function formatPanelUserSelfLine(label, data, kind) {
  const root = usageRoot(data);
  const scale = panelQuotaScale(kind);
  const quota = pickNumber(root, ["quota"]);
  const used = pickNumber(root, ["used_quota", "usedQuota"]);
  const todayIncome = pickNumber(root, ["today_income", "todayIncome"]);
  const todayUsed = pickNumber(root, ["today_quota_consumption", "todayQuotaConsumption"]);

  if (quota === undefined && used === undefined) {
    throw new Error("panel /api/user/self payload has no quota fields");
  }

  const quotaUsd = quota === undefined ? undefined : quota / scale;
  const usedUsd = used === undefined ? undefined : used / scale;
  const remainingUsd = panelQuotaLooksRemaining(kind)
    ? quotaUsd
    : (quotaUsd === undefined || usedUsd === undefined ? quotaUsd : Math.max(0, quotaUsd - usedUsd));
  const totalUsd = panelQuotaLooksRemaining(kind)
    ? (quotaUsd === undefined || usedUsd === undefined ? quotaUsd : quotaUsd + usedUsd)
    : quotaUsd;

  const parts = usageParts();
  if (remainingUsd !== undefined) parts.push(`balance ${formatMoney(remainingUsd)}`);
  if (usedUsd !== undefined && totalUsd !== undefined) {
    parts.push(`used ${formatMoney(usedUsd)}/${formatMoney(totalUsd)}`);
  } else if (usedUsd !== undefined) {
    parts.push(`used ${formatMoney(usedUsd)}`);
  }
  if (todayUsed !== undefined) parts.push(`today ${formatMoney(todayUsed / scale)}`);
  if (todayIncome !== undefined) parts.push(`income ${formatMoney(todayIncome / scale)}`);
  return parts.join(" | ");
}

function formatQuotaLimitedLine(label, root) {
  const quota = root?.quota || {};
  const limit = pickNumber(quota, ["limit", "quota"]);
  const used = pickNumber(quota, ["used", "quota_used"]);
  const remaining = pickNumber(quota, ["remaining"]) ?? pickNumber(root, ["remaining"]);
  const parts = usageParts();

  if (limit !== undefined && used !== undefined) {
    parts.push(`Q ${formatMoney(used)}/${formatMoney(limit)}`);
  } else if (remaining !== undefined) {
    parts.push(`remaining ${formatMoney(remaining)}`);
  }

  if (Array.isArray(root?.rate_limits) && root.rate_limits.length > 0) {
    const rateParts = root.rate_limits
      .map((entry) => {
        const window = entry?.window;
        const rateLimit = pickNumber(entry, ["limit"]);
        const rateUsed = pickNumber(entry, ["used"]);
        return window && rateLimit !== undefined && rateUsed !== undefined
          ? `${window} ${formatMoney(rateUsed)}/${formatMoney(rateLimit)}`
          : "";
      })
      .filter(Boolean);
    if (rateParts.length > 0) parts.push(rateParts.join(", "));
  }

  return parts.join(" | ");
}

async function formatWalletLine(label, root) {
  const balance = pickNumber(root, ["balance", "remaining", "remain", "available"]);
  const todayCost = pickNumber(root?.usage?.today, ["actual_cost", "cost"]);
  const recentUsage = Array.isArray(root?.daily_usage)
    ? root.daily_usage.reduce((sum, day) => sum + (pickNumber(day, ["actual_cost", "cost"]) || 0), 0)
    : undefined;

  const parts = usageParts();
  if (balance !== undefined) parts.push(`balance ${formatMoney(balance)}`);
  if (todayCost !== undefined) parts.push(`today ${formatMoney(todayCost)}`);
  if (recentUsage !== undefined && root.daily_usage.length > 0) {
    parts.push(`${await providerUsageDays()}d ${formatMoney(recentUsage)}`);
  }
  return parts.join(" | ");
}

function formatUsageLine(label, root) {
  const sub = root?.subscription || {};
  const dailyLimit = pickNumber(sub, ["daily_limit_usd"]);
  const dailyUsage = pickNumber(sub, ["daily_usage_usd"]);
  const weeklyLimit = pickNumber(sub, ["weekly_limit_usd"]);
  const weeklyUsage = pickNumber(sub, ["weekly_usage_usd"]);
  const monthlyLimit = pickNumber(sub, ["monthly_limit_usd"]);
  const monthlyUsage = pickNumber(sub, ["monthly_usage_usd"]);
  const expires = shortDate(sub.expires_at);

  const parts = usageParts();
  if (dailyLimit > 0 && dailyUsage !== undefined) parts.push(`D ${formatMoney(dailyUsage)}/${formatMoney(dailyLimit)}`);
  if (weeklyLimit > 0 && weeklyUsage !== undefined) parts.push(`W ${formatMoney(weeklyUsage)}/${formatMoney(weeklyLimit)}`);
  if (monthlyLimit > 0 && monthlyUsage !== undefined) parts.push(`M ${formatMoney(monthlyUsage)}/${formatMoney(monthlyLimit)}`);
  if (expires) parts.push(`Exp ${expires}`);
  return parts.join(" | ");
}
