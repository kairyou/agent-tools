// `agent-tools inspect-image` and the installed agent fallback entry for the
// vision runtime. MCP remains preferred; this direct entry covers hosts or
// model gateways that cannot invoke MCP namespace tools.
//
// Usage:
//   agent-tools inspect-image <path|url> --question "<text>" [--question "..."]
//   agent-tools inspect-image --request-file <request.json> [--json]
//
// Options:
//   -q, --question <text>   Question about the image (repeatable with a target).
//   --request-file <path>   Read MCP-shaped { image_source, questions } JSON.
//   --json                  Print the raw JSON result only.
//   -h, --help              Show this help.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createVisionService } from "./inspect.mjs";
import { isVisionError } from "./errors.mjs";

function printHelp() {
  const lines = [];
  for (const line of fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n")) {
    if (line.startsWith("//")) lines.push(line.replace(/^\/\/ ?/, ""));
    else if (lines.length) break;
  }
  console.log(lines.join("\n"));
}

function parseArgs(argv) {
  const opts = { target: null, questions: [], requestFile: null, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "-q":
      case "--question": {
        const value = argv[++i];
        if (!value) {
          console.error(`Missing value for ${a}`);
          process.exit(2);
        }
        opts.questions.push(value);
        break;
      }
      case "--json": opts.json = true; break;
      case "--request-file": {
        const value = argv[++i];
        if (!value) {
          console.error("Missing value for --request-file");
          process.exit(2);
        }
        opts.requestFile = value;
        break;
      }
      case "-h":
      case "--help": opts.help = true; break;
      default:
        if (a.startsWith("-")) {
          console.error(`Unknown option: ${a}`);
          process.exit(2);
        }
        if (opts.target) {
          console.error(`Unexpected extra argument: ${a} (one image per call)`);
          process.exit(2);
        }
        opts.target = a;
    }
  }
  return opts;
}

export async function runInspectImageCli(argv) {
  const opts = parseArgs(argv);
  if (opts.help || (!opts.target && !opts.requestFile && opts.questions.length === 0)) {
    printHelp();
    return opts.help ? 0 : 2;
  }
  if (opts.requestFile && (opts.target || opts.questions.length > 0)) {
    console.error("--request-file cannot be combined with <path|url> or --question.");
    return 2;
  }

  try {
    let imageSource;
    let questions;
    if (opts.requestFile) {
      const requestPath = path.resolve(opts.requestFile);
      let request;
      try {
        request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
      } catch (err) {
        console.error(`Cannot read --request-file ${requestPath}: ${err.message}`);
        return 2;
      }
      imageSource = request?.image_source;
      questions = request?.questions;
    } else {
      if (!opts.target) {
        console.error("Missing <path|url> argument.");
        return 2;
      }
      if (opts.questions.length === 0) {
        console.error('Missing --question. Example: --question "What error code is shown?"');
        return 2;
      }
      const type = /^https?:\/\//i.test(opts.target) ? "url" : "file";
      imageSource = { type, value: opts.target };
      questions = opts.questions.map((text, i) => ({ id: `q${i + 1}`, text }));
    }

    const service = createVisionService();
    const result = await service.inspect({
      image_source: imageSource,
      questions,
    });
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }
    console.log(`request_id: ${result.request_id}`);
    for (const answer of result.answers) {
      const q = questions.find((x) => x.id === answer.question_id);
      console.log(`\n${answer.question_id}: ${q ? q.text : ""}`);
      console.log(`  answer: ${answer.answer === null ? "(none)" : answer.answer}`);
      if (answer.uncertainty) console.log(`  uncertainty: ${answer.uncertainty}`);
    }
    return 0;
  } catch (err) {
    const code = isVisionError(err) ? err.code : "internal_error";
    console.error(`[${code}] ${err.message}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runInspectImageCli(process.argv.slice(2));
}
