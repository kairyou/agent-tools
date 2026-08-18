import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import {
  loadConfig,
  isMainModule,
  parseJsonc,
  sanitize,
} from "../skills/systems/at-zentao/scripts/zentao-cli.mjs";

const CLI = resolve("skills/systems/at-zentao/scripts/zentao-cli.mjs");
const ACCOUNT = "private-user";
const PASSWORD = "private-password";
const TOKEN = "private-token";

function tempConfig(url, password = PASSWORD) {
  const root = mkdtempSync(join(tmpdir(), "at-zentao-test-"));
  writeFileSync(
    join(root, "config.jsonc"),
    `{
      // global user config
      "zentao": {
        "url": ${JSON.stringify(url)},
        "account": ${JSON.stringify(ACCOUNT)},
        "password": ${JSON.stringify(password)},
      },
    }`
  );
  return root;
}

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function json(res, status, value) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

async function runCli(args, { env, input = "" }) {
  const child = spawn(process.execPath, [CLI, ...args], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(input);
  const code = await new Promise((resolveClose) => child.on("close", resolveClose));
  return { code, stdout, stderr };
}

function assertNoSecrets(text) {
  assert.doesNotMatch(text, new RegExp(ACCOUNT));
  assert.doesNotMatch(text, new RegExp(PASSWORD));
  assert.doesNotMatch(text, new RegExp(TOKEN));
}

test("JSONC config supports comments, trailing commas, and env secret references", () => {
  const parsed = parseJsonc('{ /* x */ "zentao": { "url": "http://example.test", }, }');
  assert.equal(parsed.zentao.url, "http://example.test");

  const root = mkdtempSync(join(tmpdir(), "at-zentao-config-"));
  const file = join(root, "config.jsonc");
  writeFileSync(file, JSON.stringify({
    zentao: {
      url: "https://zentao.example.test/",
      account: { env: "ZT_USER" },
      password: { env: "ZT_PASS" },
    },
  }));
  const config = loadConfig({ file, env: { ZT_USER: ACCOUNT, ZT_PASS: PASSWORD } });
  assert.equal(config.url, "https://zentao.example.test");
  assert.equal(config.account, ACCOUNT);
  assert.equal(config.password, PASSWORD);
});

test("CLI entry detection resolves a Skill symlink to the real script", (t) => {
  const root = mkdtempSync(join(tmpdir(), "at-zentao-link-"));
  const link = join(root, "zentao-cli.mjs");
  try {
    symlinkSync(CLI, link, "file");
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES") {
      t.skip("the current Windows environment does not allow file symlinks");
      return;
    }
    throw error;
  }
  assert.equal(isMainModule(link, `file://${CLI.replaceAll("\\", "/")}`), true);
});

test("sanitize masks secret values and secret-shaped object fields", () => {
  assert.deepEqual(
    sanitize({ account: ACCOUNT, token: TOKEN, nested: [`x ${PASSWORD}`] }, [ACCOUNT, PASSWORD, TOKEN]),
    { account: "***", token: "***", nested: ["x ***"] }
  );
});

test("Skill delegates authentication to the bundled CLI", () => {
  const skill = readFileSync(resolve("skills/systems/at-zentao/SKILL.md"), "utf8");
  assert.match(skill, /scripts\/zentao-cli\.mjs/);
  assert.match(skill, /Never read `~\/\.agent-tools\/config\.jsonc`/);
  assert.match(skill, /Never bypass the bundled CLI/);
  assert.doesNotMatch(skill, /POST \$ZENTAO_URL\/api\.php\/v1\/tokens/);
  assert.doesNotMatch(skill, /Token: <token>/);
  assert.doesNotMatch(skill, /response body verbatim/);
});

test("doctor exchanges credentials without returning identity, password, or token", async (t) => {
  let authBody;
  let userHeader;
  const fixture = await listen(async (req, res) => {
    if (req.url === "/api.php/v1/tokens") {
      authBody = JSON.parse(await body(req));
      return json(res, 200, { token: TOKEN });
    }
    if (req.url === "/api.php/v1/user") {
      userHeader = req.headers.token;
      return json(res, 200, { account: ACCOUNT, token: TOKEN });
    }
    return json(res, 404, { message: "missing" });
  });
  t.after(fixture.close);
  const root = tempConfig(fixture.url);
  const result = await runCli(["doctor"], { env: { AGENT_TOOLS_HOME: root } });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(authBody, { account: ACCOUNT, password: PASSWORD });
  assert.equal(userHeader, TOKEN);
  assertNoSecrets(result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    endpoint: fixture.url,
    authentication: "account-password",
  });
});

test("list returns only review-safe item fields", async (t) => {
  const fixture = await listen(async (req, res) => {
    if (req.url === "/api.php/v1/tokens") {
      await body(req);
      return json(res, 200, { token: TOKEN });
    }
    if (req.url === "/my-work-bug.json") {
      assert.equal(req.headers.token, TOKEN);
      return json(res, 200, {
        status: "success",
        data: JSON.stringify({
          bugs: [{
            id: 42,
            title: "Cannot save",
            severity: 2,
            status: "active",
            story: 99,
            assignedTo: ACCOUNT,
            password: PASSWORD,
            token: TOKEN,
          }],
          pager: { recTotal: 1, recPerPage: 20, pageID: 1, pageTotal: 1 },
        }),
      });
    }
    return json(res, 404, { message: "missing" });
  });
  t.after(fixture.close);
  const result = await runCli(["list", "bugs"], {
    env: { AGENT_TOOLS_HOME: tempConfig(fixture.url) },
  });
  assert.equal(result.code, 0, result.stderr);
  assertNoSecrets(result.stdout + result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.items, [{ id: 42, title: "Cannot save", severity: 2, status: "active", story: 99 }]);
  assert.equal(output.pager.recTotal, 1);
});

test("task reads expose effort and actual-date fields without unsafe data", async (t) => {
  const task = {
    id: 7,
    name: "Multi-day task",
    status: "doing",
    story: 99,
    estimate: 16,
    consumed: 2,
    left: 14,
    realStarted: "2026-08-11 09:00:00",
    finishedDate: null,
    assignedTo: ACCOUNT,
    password: PASSWORD,
  };
  const fixture = await listen(async (req, res) => {
    if (req.url === "/api.php/v1/tokens") {
      await body(req);
      return json(res, 200, { token: TOKEN });
    }
    if (req.url === "/my-work-task.json") {
      return json(res, 200, {
        status: "success",
        data: JSON.stringify({ tasks: [task] }),
      });
    }
    if (req.url === "/api.php/v1/tasks/7") return json(res, 200, task);
    return json(res, 404, { message: "missing" });
  });
  t.after(fixture.close);
  const env = { AGENT_TOOLS_HOME: tempConfig(fixture.url) };
  const listed = await runCli(["list", "tasks"], { env });
  const detail = await runCli(["get", "task", "7"], { env });
  assert.equal(listed.code, 0, listed.stderr);
  assert.equal(detail.code, 0, detail.stderr);
  assertNoSecrets(listed.stdout + listed.stderr + detail.stdout + detail.stderr);
  assert.deepEqual(JSON.parse(listed.stdout).items, [{
    id: 7,
    name: "Multi-day task",
    status: "doing",
    story: 99,
    estimate: 16,
    consumed: 2,
    left: 14,
    realStarted: "2026-08-11 09:00:00",
    finishedDate: null,
  }]);
  assert.deepEqual(JSON.parse(detail.stdout).item, {
    id: 7,
    name: "Multi-day task",
    status: "doing",
    story: 99,
    estimate: 16,
    consumed: 2,
    left: 14,
    realStarted: "2026-08-11 09:00:00",
    finishedDate: null,
  });
});

test("story reads expose only development context and download story attachments", async (t) => {
  const fixture = await listen(async (req, res) => {
    if (req.url === "/api.php/v1/tokens") {
      await body(req);
      return json(res, 200, { token: TOKEN });
    }
    if (req.url === "/api.php/v1/stories/99") {
      return json(res, 200, {
        id: 99,
        title: "Support approval flow",
        status: "active",
        stage: "developing",
        pri: 2,
        estimate: 8,
        spec: '<p>Managers can approve requests. <img src="/file-read-88.png"></p>',
        verify: "Approved requests are immutable.",
        openedBy: ACCOUNT,
        password: PASSWORD,
        token: TOKEN,
      });
    }
    if (req.url === "/file-read-88.png") {
      assert.equal(req.headers.token, TOKEN);
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    }
    return json(res, 404, { message: "missing" });
  });
  t.after(fixture.close);
  const download = mkdtempSync(join(tmpdir(), "at-zentao-story-"));
  const result = await runCli(["get", "story", "99", "--download-dir", download], {
    env: { AGENT_TOOLS_HOME: tempConfig(fixture.url) },
  });
  assert.equal(result.code, 0, result.stderr);
  assertNoSecrets(result.stdout + result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.item, {
    id: 99,
    title: "Support approval flow",
    status: "active",
    pri: 2,
    stage: "developing",
    estimate: 8,
    spec: '<p>Managers can approve requests. <img src="/file-read-88.png"></p>',
    verify: "Approved requests are immutable.",
  });
  assert.equal(output.attachments.length, 1);
  assert.ok(existsSync(output.attachments[0].path));
  assert.deepEqual([...readFileSync(output.attachments[0].path)], [0x89, 0x50, 0x4e, 0x47]);
});

test("story support remains read-only", async () => {
  const result = await runCli(["comment", "story", "99"], {
    env: {
      AGENT_TOOLS_HOME: mkdtempSync(join(tmpdir(), "at-zentao-story-write-")),
      ZENTAO_URL: "http://127.0.0.1:1",
      ZENTAO_TOKEN: TOKEN,
    },
    input: JSON.stringify({ comment: "Do not write this." }),
  });
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stderr).error, "usage_error");
});

test("get downloads token-gated images and returns local paths", async (t) => {
  const fixture = await listen(async (req, res) => {
    if (req.url === "/api.php/v1/tokens") {
      await body(req);
      return json(res, 200, { token: TOKEN });
    }
    if (req.url === "/api.php/v1/bugs/42") {
      return json(res, 200, {
        id: 42,
        title: "Screenshot bug",
        steps: '<p>See <img src="/file-read-99.png"></p>',
        assignedTo: ACCOUNT,
      });
    }
    if (req.url === "/file-read-99.png") {
      assert.equal(req.headers.token, TOKEN);
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    }
    return json(res, 404, { message: "missing" });
  });
  t.after(fixture.close);
  const download = mkdtempSync(join(tmpdir(), "at-zentao-download-"));
  const result = await runCli(["get", "bug", "42", "--download-dir", download], {
    env: { AGENT_TOOLS_HOME: tempConfig(fixture.url) },
  });
  assert.equal(result.code, 0, result.stderr);
  assertNoSecrets(result.stdout + result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.item.title, "Screenshot bug");
  assert.equal(output.attachments.length, 1);
  assert.ok(existsSync(output.attachments[0].path));
  assert.deepEqual([...readFileSync(output.attachments[0].path)], [0x89, 0x50, 0x4e, 0x47]);
});

test("resolve keeps credentials internal and preserves UTF-8 comments", async (t) => {
  let form;
  const fixture = await listen(async (req, res) => {
    if (req.url === "/api.php/v1/tokens") {
      await body(req);
      return json(res, 200, { token: TOKEN });
    }
    if (req.url === "/bug-resolve-42.json") {
      assert.equal(req.headers.token, TOKEN);
      form = new URLSearchParams(await body(req));
      return json(res, 200, { status: "success", data: JSON.stringify({ result: "success" }) });
    }
    return json(res, 404, { message: "missing" });
  });
  t.after(fixture.close);
  const input = JSON.stringify({ resolution: "fixed", comment: "修复登录状态, commit abc1234." });
  const result = await runCli(["resolve", "bug", "42"], {
    env: { AGENT_TOOLS_HOME: tempConfig(fixture.url) },
    input,
  });
  assert.equal(result.code, 0, result.stderr);
  assertNoSecrets(result.stdout + result.stderr);
  assert.equal(form.get("responsibleBy"), ACCOUNT);
  assert.equal(form.get("comment"), "修复登录状态, commit abc1234.");
});

test("finish computes total consumed time inside the CLI", async (t) => {
  let submitted;
  const fixture = await listen(async (req, res) => {
    if (req.url === "/api.php/v1/tokens") {
      await body(req);
      return json(res, 200, { token: TOKEN });
    }
    if (req.url === "/task-finish-7.json" && req.method === "GET") {
      return json(res, 200, {
        status: "success",
        data: JSON.stringify({ task: { consumed: 2, realStarted: "2026-08-11 09:00:00" } }),
      });
    }
    if (req.url === "/task-finish-7.json" && req.method === "POST") {
      submitted = new URLSearchParams(await body(req));
      return json(res, 200, { status: "success", data: JSON.stringify({ result: "success" }) });
    }
    return json(res, 404, { message: "missing" });
  });
  t.after(fixture.close);
  const input = JSON.stringify({ currentConsumed: 1.5, finishedDate: "2026-08-11 10:30:00" });
  const result = await runCli(["finish", "task", "7"], {
    env: { AGENT_TOOLS_HOME: tempConfig(fixture.url) },
    input,
  });
  assert.equal(result.code, 0, result.stderr);
  assertNoSecrets(result.stdout + result.stderr);
  assert.equal(submitted.get("currentConsumed"), "1.5");
  assert.equal(submitted.get("consumed"), "3.5");
  assert.equal(submitted.get("realStarted"), "2026-08-11 09:00:00");
  assert.equal(submitted.get("finishedDate"), "2026-08-11 10:30:00");
});

test("log-hours uses recordWorkhour on modern ZenTao", async (t) => {
  let submitted;
  let legacyCalls = 0;
  const fixture = await listen(async (req, res) => {
    if (req.url === "/api.php/v1/tokens") {
      await body(req);
      return json(res, 200, { token: TOKEN });
    }
    if (req.url === "/task-recordworkhour-7.json" && req.method === "GET") {
      return json(res, 200, {
        status: "success",
        data: JSON.stringify({ task: { id: 7 } }),
      });
    }
    if (req.url === "/task-recordworkhour-7.json" && req.method === "POST") {
      submitted = new URLSearchParams(await body(req));
      return json(res, 200, {
        status: "success",
        data: JSON.stringify({ result: "success" }),
      });
    }
    if (req.url === "/task-recordestimate-7.json") legacyCalls += 1;
    return json(res, 404, { message: "missing" });
  });
  t.after(fixture.close);
  const input = JSON.stringify({
    date: "2026-08-17",
    consumed: 2,
    left: 14,
    work: "完成第一部分实现.",
  });
  const result = await runCli(["log-hours", "task", "7"], {
    env: { AGENT_TOOLS_HOME: tempConfig(fixture.url) },
    input,
  });
  assert.equal(result.code, 0, result.stderr);
  assertNoSecrets(result.stdout + result.stderr);
  assert.equal(legacyCalls, 0);
  assert.equal(submitted.get("id[1]"), null);
  assert.equal(submitted.get("date[1]"), "2026-08-17");
  assert.equal(submitted.get("consumed[1]"), "2");
  assert.equal(submitted.get("left[1]"), "14");
  assert.equal(submitted.get("work[1]"), "完成第一部分实现.");
});

test("log-hours falls back to recordEstimate before writing on legacy ZenTao", async (t) => {
  let submitted;
  let postCount = 0;
  const fixture = await listen(async (req, res) => {
    if (req.url === "/api.php/v1/tokens") {
      await body(req);
      return json(res, 200, { token: TOKEN });
    }
    if (req.url === "/task-recordworkhour-7.json") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("the module task has no recordworkhour method");
    }
    if (req.url === "/task-recordestimate-7.json" && req.method === "GET") {
      return json(res, 200, {
        status: "success",
        data: JSON.stringify({ task: { id: 7 } }),
      });
    }
    if (req.url === "/task-recordestimate-7.json" && req.method === "POST") {
      postCount += 1;
      submitted = new URLSearchParams(await body(req));
      return json(res, 200, {
        status: "success",
        data: JSON.stringify({ result: "success" }),
      });
    }
    return json(res, 404, { message: "missing" });
  });
  t.after(fixture.close);
  const result = await runCli(["log-hours", "task", "7"], {
    env: { AGENT_TOOLS_HOME: tempConfig(fixture.url) },
    input: JSON.stringify({
      date: "2026-08-17",
      consumed: 2,
      left: 14,
      work: "完成第一部分实现.",
    }),
  });
  assert.equal(result.code, 0, result.stderr);
  assertNoSecrets(result.stdout + result.stderr);
  assert.equal(postCount, 1);
  assert.equal(submitted.get("id[1]"), "1");
  assert.equal(submitted.get("dates[1]"), "2026-08-17");
  assert.equal(submitted.get("date[1]"), null);
  assert.equal(submitted.get("consumed[1]"), "2");
  assert.equal(submitted.get("left[1]"), "14");
  assert.equal(submitted.get("work[1]"), "完成第一部分实现.");
});

test("log-hours stops without writing when neither workhour route exists", async (t) => {
  let postCount = 0;
  const fixture = await listen(async (req, res) => {
    if (req.url === "/api.php/v1/tokens") {
      await body(req);
      return json(res, 200, { token: TOKEN });
    }
    if (req.method === "POST" && req.url.startsWith("/task-")) postCount += 1;
    return json(res, 404, { message: "missing" });
  });
  t.after(fixture.close);
  const result = await runCli(["log-hours", "task", "7"], {
    env: { AGENT_TOOLS_HOME: tempConfig(fixture.url) },
    input: JSON.stringify({ consumed: 2, left: 14, work: "No route." }),
  });
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stderr).error, "unsupported_version");
  assert.equal(postCount, 0);
});

test("log-hours allows an omitted work description", async (t) => {
  let submitted;
  const fixture = await listen(async (req, res) => {
    if (req.url === "/api.php/v1/tokens") {
      await body(req);
      return json(res, 200, { token: TOKEN });
    }
    if (req.url === "/task-recordworkhour-7.json" && req.method === "GET") {
      return json(res, 200, { status: "success", data: JSON.stringify({ task: { id: 7 } }) });
    }
    if (req.url === "/task-recordworkhour-7.json" && req.method === "POST") {
      submitted = new URLSearchParams(await body(req));
      return json(res, 200, { status: "success", data: JSON.stringify({ result: "success" }) });
    }
    return json(res, 404, { message: "missing" });
  });
  t.after(fixture.close);
  const result = await runCli(["log-hours", "task", "7"], {
    env: { AGENT_TOOLS_HOME: tempConfig(fixture.url) },
    input: JSON.stringify({ consumed: 2, left: 14 }),
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(submitted.get("work[1]"), null);
});

test("log-hours rejects values that would be invalid or finish the task", async () => {
  const env = {
    AGENT_TOOLS_HOME: mkdtempSync(join(tmpdir(), "at-zentao-effort-validation-")),
    ZENTAO_URL: "http://127.0.0.1:1",
    ZENTAO_TOKEN: TOKEN,
  };
  const cases = [
    { consumed: 0, left: 2, work: "No time." },
    { consumed: 2, left: 0, work: "Would finish." },
    { consumed: 2, left: 2, work: 42 },
    { date: "2026-02-30", consumed: 2, left: 2, work: "Invalid date." },
    { date: "2999-01-01", consumed: 2, left: 2, work: "Future date." },
  ];
  for (const input of cases) {
    const result = await runCli(["log-hours", "task", "7"], {
      env,
      input: JSON.stringify(input),
    });
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stderr).error, "usage_error");
  }
});

test("authentication and API failures never echo server-provided secrets", async (t) => {
  const authFailure = await listen(async (req, res) => {
    await body(req);
    json(res, 401, { message: `${ACCOUNT} ${PASSWORD} ${TOKEN}` });
  });
  t.after(authFailure.close);
  const failedAuth = await runCli(["doctor"], {
    env: { AGENT_TOOLS_HOME: tempConfig(authFailure.url) },
  });
  assert.equal(failedAuth.code, 1);
  assertNoSecrets(failedAuth.stdout + failedAuth.stderr);
  assert.equal(JSON.parse(failedAuth.stderr).error, "auth_error");

  const apiFailure = await listen(async (req, res) => {
    if (req.url === "/api.php/v1/tokens") {
      await body(req);
      return json(res, 200, { token: TOKEN });
    }
    return json(res, 500, { message: `${ACCOUNT} ${PASSWORD} ${TOKEN}` });
  });
  t.after(apiFailure.close);
  const failedApi = await runCli(["list", "bugs"], {
    env: { AGENT_TOOLS_HOME: tempConfig(apiFailure.url) },
  });
  assert.equal(failedApi.code, 1);
  assertNoSecrets(failedApi.stdout + failedApi.stderr);
  assert.equal(JSON.parse(failedApi.stderr).error, "http_error");
});

test("ZENTAO_TOKEN skips password exchange and remains hidden", async (t) => {
  let tokenCalls = 0;
  const fixture = await listen(async (req, res) => {
    if (req.url === "/api.php/v1/tokens") tokenCalls += 1;
    if (req.url === "/api.php/v1/user") {
      assert.equal(req.headers.token, TOKEN);
      return json(res, 200, { token: TOKEN });
    }
    return json(res, 404, { message: "missing" });
  });
  t.after(fixture.close);
  const result = await runCli(["doctor"], {
    env: {
      AGENT_TOOLS_HOME: mkdtempSync(join(tmpdir(), "at-zentao-token-")),
      ZENTAO_URL: fixture.url,
      ZENTAO_TOKEN: TOKEN,
      ZENTAO_ACCOUNT: "",
      ZENTAO_PASSWORD: "",
    },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(tokenCalls, 0);
  assertNoSecrets(result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).authentication, "token");
});
