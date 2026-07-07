// Shared guard rules — the single source of truth for which shell commands are
// considered catastrophic. Consumed by every agent wiring:
//   - Claude / Codex: hooks/common/guard-command.mjs (stdin/stdout CLI)
//   - opencode:       hooks/opencode/guard.js (plugin, throws to block)
//
// The deny-list is intentionally TINY and targets only patterns with
// essentially no legitimate use inside an agent session, to keep false
// positives near zero. This is a safety net, not a sandbox.

// A drive-root or home target: matches `C:\`, `C:/`, `C:`, but NOT a deep path
// like `C:\Users\x\build` (so recursive deletes of specific subdirs are allowed).
const WIN_ROOT = "[A-Za-z]:[\\\\/]?(?:\\s|$|[\"'])";

export const RULES = [
  // --- Unix / POSIX ---
  {
    re: /\(\s*\)\s*\{\s*:\s*\|\s*:?\s*&\s*\}\s*;\s*:/,
    reason: "fork bomb",
  },
  {
    // rm with a recursive+force flag aimed at /, /*, ~, $HOME, a root override,
    // or a Windows drive root (git-bash `rm -rf C:/`).
    re: /\brm\b[^|;&\n]*?\s-[a-zA-Z]*(?:rf|fr|r[a-zA-Z]*f|f[a-zA-Z]*r)[a-zA-Z]*\b[^|;&\n]*?\s(?:--no-preserve-root|\/|\/\*|~|\$HOME|[A-Za-z]:[\\/]?)(?:\s|$|["'])/,
    reason: "recursive force-remove of a root/home path",
  },
  {
    re: /\bmkfs(?:\.\w+)?\s/,
    reason: "filesystem format (mkfs)",
  },
  {
    re: /\bdd\b[^|;&\n]*\bof=\/dev\/(?:sd|nvme|hd|disk|mmcblk)/,
    reason: "dd writing to a raw block device",
  },
  {
    re: />\s*\/dev\/(?:sd|nvme|hd|disk|mmcblk)/,
    reason: "redirect overwriting a raw block device",
  },
  {
    re: /\bchmod\s+-[a-zA-Z]*R[a-zA-Z]*\s+0*777\s+\/(?:\s|$)/,
    reason: "recursive chmod 777 on /",
  },
  {
    re: /\b(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash)\b/,
    reason: "piping a network download straight into a shell",
  },

  // --- Windows / PowerShell / cmd.exe ---
  {
    // PowerShell recursive+force removal aimed at a drive root or home.
    // Lookaheads make flag/argument order irrelevant.
    re: new RegExp(
      "^(?=[\\s\\S]*\\b(?:remove-item|ri|rm|rd|rmdir|del|erase)\\b)" +
        "(?=[\\s\\S]*-r(?:ec(?:urse)?)?\\b)" +
        "(?=[\\s\\S]*-fo(?:rce)?\\b)" +
        "[\\s\\S]*(?:" + WIN_ROOT +
        "|\\$env:userprofile\\b|%userprofile%|\\$env:systemdrive\\b|\\$home\\b|~[\\\\/]?(?:\\s|$))",
      "i"
    ),
    reason: "recursive force-remove of a Windows drive root or home",
  },
  {
    // cmd.exe recursive delete of a drive root: del/rd/rmdir /s ... C:\
    re: new RegExp(
      "\\b(?:del|erase|rd|rmdir)\\b[^|;&\\n]*?\\s/s\\b[^|;&\\n]*?" + WIN_ROOT,
      "i"
    ),
    reason: "recursive delete of a Windows drive root (del/rd /s)",
  },
  {
    // Formatting a drive: `format C:` / `format /q C:`
    re: /\bformat\b[^|;&\n]*?\b[A-Za-z]:[\\/]?(?:\s|$|["'])/i,
    reason: "formatting a Windows drive",
  },
];

// Normalize a tool_input.command (string or argv array) to a single string.
export function toCommandString(command) {
  if (Array.isArray(command)) return command.join(" ");
  return typeof command === "string" ? command : "";
}

// Returns the matched rule's reason string, or null if the command is allowed.
export function checkCommand(command) {
  const cmd = toCommandString(command);
  if (!cmd) return null;
  for (const rule of RULES) {
    if (rule.re.test(cmd)) return rule.reason;
  }
  return null;
}
