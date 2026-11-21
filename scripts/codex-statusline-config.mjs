import { parseTOML } from "toml-eslint-parser";
import { supportsCodexStatuslineField } from "../capabilities/statusline/codex-statusline-fields.mjs";

const feature = ["features", "tui_extensions_statusline"];
const selection = ["tui", "status_line_provider"];
const startsWith = (path, prefix) => prefix.every((part, index) => part === path[index]);
const keyFor = (path) => JSON.stringify(path);

function locations(text) {
  const root = parseTOML(text).body[0];
  const tables = [{ path: [], node: root }];
  const values = new Map();
  function add(node, prefix) {
    if (node.type === "TOMLTable") {
      const path = node.resolvedKey;
      tables.push({ path, node });
      for (const child of node.body) add(child, path);
      return;
    }
    const path = [...prefix, ...node.key.keys.map((key) => key.name ?? key.value)];
    values.set(keyFor(path), node);
    if (node.value.type === "TOMLInlineTable") {
      tables.push({ path, node: node.value });
      for (const child of node.value.body) add(child, path);
    }
  }
  for (const node of root.body) add(node, []);
  return { tables, values, firstTable: root.body.find((node) => node.type === "TOMLTable") };
}

function replace(text, start, end, value) {
  return text.slice(0, start) + value + text.slice(end);
}

function setValue(text, path, value) {
  const { tables, values, firstTable } = locations(text);
  const entry = values.get(keyFor(path));
  if (entry && value !== null) return replace(text, ...entry.value.range, value);
  if (entry && entry.parent.type === "TOMLInlineTable") {
    const siblings = entry.parent.body;
    const index = siblings.indexOf(entry);
    const next = siblings[index + 1];
    const previous = siblings[index - 1];
    return next ? replace(text, entry.range[0], next.range[0], "") :
      replace(text, previous?.range[1] ?? entry.range[0], entry.range[1], "");
  }
  const lineStart = (offset) => text.lastIndexOf("\n", offset - 1) + 1;
  const lineEnd = (offset) => {
    const end = text.indexOf("\n", offset);
    return end === -1 ? text.length : end + 1;
  };
  if (entry) return replace(text, lineStart(entry.range[0]), lineEnd(entry.range[1]), "");
  if (value === null) return text;

  const { path: prefix, node } = tables.filter((table) => table.path.length < path.length && startsWith(path, table.path))
    .sort((a, b) => b.path.length - a.path.length)[0];
  const assignment = `${path.slice(prefix.length).join(".")} = ${value}`;
  if (node.type === "TOMLInlineTable") {
    const last = node.body.at(-1);
    const at = last?.range[1] ?? node.range[0] + 1;
    return replace(text, at, at, last ? `, ${assignment}` : assignment);
  }
  const at = node.type === "TOMLTable" ? lineEnd(node.key.range[1]) : firstTable ? lineStart(firstTable.range[0]) : text.length;
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  return replace(text, at, at, `${at && text[at - 1] !== "\n" ? newline : ""}${assignment}${newline}`);
}

export function codexStatuslineConflict(text, server) {
  const { tables, values } = locations(text);
  const fields = values.get(keyFor(["tui", "status_line"]))?.value;
  if (fields && (fields.type !== "TOMLArray" || fields.elements.some((field) => !supportsCodexStatuslineField(field.value)))) {
    return "Keeping the native Codex status line for the configured fields.";
  }
  const provider = values.get(keyFor(selection));
  const currentServer = values.get(keyFor([...selection, "server"]));
  const currentTool = values.get(keyFor([...selection, "tool"]));
  if (currentServer?.value.value === server && currentTool?.value.value === "statusline") return "";
  if (provider ? provider.value.value !== "default" : tables.some(({ path }) => startsWith(path, selection)) || currentServer || currentTool) {
    return "Keeping the configured Codex status line provider.";
  }
  return "";
}

export function editCodexStatusline(text, { enabled, server, backup }) {
  const original = locations(text);
  const valueAt = (path) => original.values.get(keyFor(path));
  const matches = ({ path, expected }) => {
    const node = valueAt(path)?.value;
    if (typeof expected !== "object") return node?.value === expected;
    return node?.type === "TOMLInlineTable" && Object.entries(expected)
      .every(([key, value]) => valueAt([...path, key])?.value.value === value);
  };
  const owns = (group) => group?.every(matches);
  if (!enabled) {
    // A user may have selected another provider since installation.
    const restoreSelection = owns(backup?.selection);
    for (const group of [restoreSelection && backup.selection, (!backup?.selection || restoreSelection) && backup?.feature]) {
      if (group && owns(group)) for (const { path, previous } of group) text = setValue(text, path, previous);
    }
    parseTOML(text);
    return { text };
  }

  const tool = "statusline";
  const nested = !valueAt(selection) && (original.tables.some(({ path }) => startsWith(path, selection)) ||
    valueAt([...selection, "server"]) || valueAt([...selection, "tool"]));
  const desired = {
    feature: [{ path: feature, expected: true, value: "true" }],
    selection: nested ? [
      { path: [...selection, "server"], expected: server, value: JSON.stringify(server) },
      { path: [...selection, "tool"], expected: tool, value: JSON.stringify(tool) },
    ] : [{ path: selection, expected: { server, tool }, value: `{ server = ${JSON.stringify(server)}, tool = "${tool}" }` }],
  };
  const nextBackup = {};
  for (const [key, group] of Object.entries(desired)) {
    if (owns(group)) {
      if (owns(backup?.[key])) nextBackup[key] = backup[key];
      continue;
    }
    nextBackup[key] = group.map(({ path, expected }) => {
      const saved = backup?.[key]?.find((item) => keyFor(item.path) === keyFor(path) && matches(item));
      if (saved) return saved;
      const entry = valueAt(path);
      return { path, expected, previous: entry ? text.slice(...entry.value.range) : null };
    });
  }
  for (const group of Object.values(desired)) {
    if (!owns(group)) for (const { path, value } of group) text = setValue(text, path, value);
  }
  parseTOML(text);
  return { text, backup: Object.keys(nextBackup).length ? nextBackup : undefined };
}
