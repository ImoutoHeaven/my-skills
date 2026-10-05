import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";

const broker = fileURLToPath(new URL("./pi-subagent-broker.mjs", import.meta.url));
// Render the broker's CR/erase-line protocol like a progress-aware launcher.
const render = (output) => stripVTControlCharacters(output).split("\n").map((line) => line.split("\r").at(-1)).join("\n");

// Mirrors Pi 0.99.1 RPC queue semantics: a prompt starts a run only while idle and
// needs streamingBehavior while streaming; steer/follow_up records only enqueue.
// A "late" prompt models slow input handlers: Pi decides queue-or-start after
// they finish, so it starts after the current run settles. Abort acknowledges
// once idle and, like a cancelled retry, emits no aborted message.
// History persists in --session-dir only when --continue resumes it.
const fakePi = `
const { appendFileSync, existsSync, mkdirSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const argv = process.argv.slice(2);
const sessionDir = argv[argv.indexOf("--session-dir") + 1];
const historyFile = join(sessionDir, "history.txt");
const [provider, id] = (argv.includes("--model") ? argv[argv.indexOf("--model") + 1] : "default/none").split("/");
const history = () => (argv.includes("--continue") && existsSync(historyFile) ? readFileSync(historyFile, "utf8").split("\\n").filter(Boolean) : []);
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const sleep = (ms) => new Promise((wake) => setTimeout(wake, ms));
let streaming = false;
let aborted = false;
const steering = [];
const followUps = [];
const dialogs = new Map();
async function runAgent(message) {
  streaming = true;
  send({ type: "agent_start" });
  let batch = [message];
  while (batch.length) {
    const prior = history();
    send({ type: "turn_start" });
    mkdirSync(sessionDir, { recursive: true });
    for (const text of batch) appendFileSync(historyFile, text + "\\n");
    send({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash" });
    send({ type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", isError: false });
    let reply = "reply:" + batch.join("+");
    if (batch.includes("progress")) {
      send({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, errorMessage: "temporary failure" });
      send({ type: "auto_retry_end", success: true });
      send({ type: "compaction_start" });
      send({ type: "compaction_end" });
      for (let i = 0; i < 3; i++) send({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "private-thought" } });
      while (!existsSync("start-tools") && !aborted) await sleep(20);
      if (aborted) break;
      send({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", toolName: "edit" } });
      send({ type: "tool_execution_start", toolCallId: "edit-1", toolName: "edit" });
      send({ type: "tool_execution_start", toolCallId: "checkpoint-1", toolName: "checkpoint" });
      send({ type: "tool_execution_end", toolCallId: "checkpoint-1", toolName: "checkpoint", isError: false });
      while (!existsSync("release") && !aborted) await sleep(20);
      if (aborted) break;
      send({ type: "tool_execution_end", toolCallId: "edit-1", toolName: "edit", isError: false });
    }
    if (batch.includes("hold")) {
      while (!existsSync("release") && !aborted) await sleep(20);
      if (aborted) break;
      const answer = await new Promise((resolve) => {
        dialogs.set("dialog-1", resolve);
        send({ type: "extension_ui_request", id: "dialog-1", method: "confirm", title: "Allow?" });
      });
      reply += answer.cancelled ? " dialog=cancelled" : " dialog=answered";
    }
    if (batch.includes("recall")) reply += " prior=" + prior.join(",");
    send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: reply } });
    send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: reply }], stopReason: "stop" } });
    send({ type: "turn_end" });
    batch = steering.length ? steering.splice(0) : followUps.splice(0);
  }
  streaming = false;
  send({ type: "agent_settled" });
}
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) !== -1) {
    const command = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    const ok = (data) => send({ id: command.id, type: "response", command: command.type, success: true, data });
    if (command.type === "get_state") ok({ model: { provider, id }, thinkingLevel: "off", isStreaming: streaming, messageCount: history().length });
    else if (command.type === "abort") { aborted = true; (async () => { while (streaming) await sleep(10); ok(); })(); }
    else if (command.type === "prompt" && command.message === "late") {
      (async () => { while (streaming) await sleep(10); ok({ disposition: "started" }); runAgent(command.message); })();
    }
    else if (command.type === "extension_ui_response") dialogs.get(command.id)(command);
    else if (command.type === "steer") { steering.push(command.message); ok({ disposition: "queued" }); }
    else if (command.type === "follow_up") { followUps.push(command.message); ok({ disposition: "queued" }); }
    else if (command.type === "prompt" && !streaming) { ok({ disposition: "started" }); runAgent(command.message); }
    else if (command.type === "prompt" && command.streamingBehavior) {
      (command.streamingBehavior === "steer" ? steering : followUps).push(command.message);
      ok({ disposition: "queued" });
    } else send({ id: command.id, type: "response", command: command.type, success: false, error: "Agent is already processing" });
  }
});
process.stdin.on("end", () => process.exit(0));
`;

async function waitFor(check, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((wake) => setTimeout(wake, 25));
  }
  throw new Error("Timed out waiting for broker");
}

function setup(context, outputToFile = false) {
  const root = mkdtempSync(join(tmpdir(), "pi-subagent-broker-test-"));
  const piBin = join(root, "fake-pi.cjs");
  writeFileSync(piBin, fakePi);
  const runDir = join(root, "run");
  const children = [];
  context.after(() => {
    for (const child of children) if (child.exitCode === null) child.kill();
    rmSync(root, { recursive: true, force: true });
  });
  const env = { ...process.env, PI_BIN: piBin };
  const start = (...args) => {
    const fd = outputToFile ? openSync(join(root, "run.out"), "w") : null;
    let child;
    try {
      child = spawn(process.execPath, [broker, "run", runDir, "--cwd", root, ...args], {
        env, windowsHide: true, stdio: fd === null ? "pipe" : ["pipe", fd, fd],
      });
    } finally {
      if (fd !== null) closeSync(fd);
    }
    child.rawOutput = "";
    Object.defineProperty(child, "output", { get: () => render(child.rawOutput) });
    child.stdout?.on("data", (chunk) => (child.rawOutput += chunk));
    child.stderr?.on("data", (chunk) => (child.rawOutput += chunk));
    child.exited = new Promise((done) => child.on("exit", (code) => done(code)));
    children.push(child);
    return child;
  };
  const cli = (...args) => spawnSync(process.execPath, [broker, ...args], { env, encoding: "utf8", windowsHide: true });
  const status = () => cli("status", runDir).stdout;
  return { root, runDir, start, cli, status };
}

test("a live run applies steering and follow-ups, cancels dialogs, and exits when settled", { timeout: 20000 }, async (context) => {
  const { root, runDir, start, cli, status } = setup(context);
  const run = start("hold");
  await waitFor(() => status().startsWith("working"));

  const steer = cli("steer", runDir, "S");
  assert.equal(steer.status, 0, steer.stderr);
  assert.equal(steer.stdout.trim(), "steer queued");
  const followUp = cli("follow-up", runDir, "F");
  assert.equal(followUp.status, 0, followUp.stderr);
  writeFileSync(join(root, "release"), "");

  assert.equal(await run.exited, 0, run.output);
  const lines = run.output.trim().split(/\r?\n/);
  assert.deepEqual(lines.slice(-4), [
    "[t2] reply:S",
    "[t3] reply:F",
    `settled t3 → ${join(runDir, "final.md")}`,
    "reply:F",
  ]);
  assert.ok(lines.includes("[t1] reply:hold dialog=cancelled"), run.output);
  assert.doesNotMatch(run.output, /call-1/);
  assert.equal(readFileSync(join(runDir, "final.md"), "utf8"), "reply:F");

  const late = cli("follow-up", runDir, "late");
  assert.equal(late.status, 1);
  assert.match(late.stderr, /No live run/);
});

test("current is replaced in place, refreshes event age, and leaves durable messages intact", { timeout: 15000 }, async (context) => {
  const { root, runDir, start, cli, status } = setup(context);
  const run = start("progress");
  const progress = () => readFileSync(join(runDir, "progress.log"), "utf8");
  await waitFor(() => run.output.includes("current: running · turn 1 · thinking"));
  assert.equal(run.output.match(/current:/g).length, 1, run.output);
  assert.match(progress(), /current: running · turn 1 · retrying \(1\/3\)/);
  assert.match(progress(), /current: running · turn 1 · compacting/);
  assert.match(status(), /^working t1 · thinking · last event \d+s ago/);

  writeFileSync(join(root, "start-tools"), "");
  await waitFor(() => progress().includes("tool-calling (edit, checkpoint)") && run.output.includes("tool-calling (edit)"));
  assert.match(progress(), /current: running · turn 1 · preparing tool call \(edit\)/);
  assert.match(status(), /^working t1 · tool-calling \(edit\) · last event \d+s ago/);
  const phaseLog = progress();
  await waitFor(() => /tool-calling \(edit\) · last event [1-9]\d*s ago/.test(run.output), 4000);
  await waitFor(() => /tool-calling \(edit\) · last event [2-9]\d*s ago/.test(run.output), 4000);
  assert.equal(run.output.match(/current:/g).length, 1, run.output);
  assert.equal(progress(), phaseLog, "refreshes must not grow progress.log");
  assert.doesNotMatch(run.rawOutput, /private-thought|edit-1|checkpoint-1/);

  assert.equal(cli("follow-up", runDir, "F").status, 0);
  await waitFor(() => /tool-calling \(edit\) · last event 0s ago/.test(run.output));
  assert.match(run.output, /^follow_up queued$/m);
  assert.equal(run.output.match(/current:/g).length, 1, run.output);
  writeFileSync(join(root, "release"), "");
  assert.equal(await run.exited, 0, run.output);
  assert.match(progress(), /current: running · turn 2 · waiting for model/);
  assert.match(progress(), /current: running · turn 2 · streaming reply/);
  assert.equal(readFileSync(join(runDir, "final.md"), "utf8"), "reply:F");
  assert.doesNotMatch(run.output, /current:/);
  assert.match(run.output, /^\[t1\] reply:progress$/m);
  assert.match(run.output, /settled t2 .*\nreply:F\n$/);
  assert.equal(progress().split("\n").filter((line) => !line.startsWith("current:")).join("\n"), run.output);
});

test("redirected output is plain append-only text without periodic current lines", { timeout: 15000 }, async (context) => {
  const { root, runDir, start, status } = setup(context, true);
  const run = start("progress");
  const output = () => readFileSync(join(root, "run.out"), "utf8");
  await waitFor(() => output().includes("· thinking ·"));
  const before = output();
  const { lastEventAt } = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
  await waitFor(() => Date.now() - lastEventAt >= 2200);
  assert.equal(output(), before, "silent refreshes must not append to redirected output");
  assert.match(status(), /^working t1 · thinking · last event [2-9]\d*s ago/);
  writeFileSync(join(root, "start-tools"), "");
  writeFileSync(join(root, "release"), "");
  assert.equal(await run.exited, 0, output());
  assert.doesNotMatch(output(), /[\r\x1b]/);
  assert.match(output(), /settled t1 .*\nreply:progress\n$/);
  assert.equal(readFileSync(join(runDir, "progress.log"), "utf8"), output());
});

test("terminal current frames disable autowrap only while rendering", (context) => {
  const { root, runDir } = setup(context);
  const result = spawnSync(process.execPath, [
    "--import", "data:text/javascript,process.stdout.isTTY=true",
    broker, "run", runDir, "--cwd", root, "hello",
  ], { env: { ...process.env, PI_BIN: join(root, "fake-pi.cjs") }, encoding: "utf8", windowsHide: true, timeout: 10000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const frames = result.stdout.match(/\x1b\[\?7lcurrent:[^\r\n]*?\x1b\[\?7h/g) || [];
  assert.ok(frames.length > 0, "terminal progress needs scoped autowrap control");
  const messages = result.stdout.replace(/\x1b\[\?7lcurrent:[^\r\n]*?\x1b\[\?7h/g, "");
  assert.doesNotMatch(messages, /current:|\x1b\[\?7[lh]/);
  assert.match(render(result.stdout), /^reply:hello$/m);
});

test("a follow-up that starts after the run settles keeps the broker alive", { timeout: 20000 }, async (context) => {
  const { root, runDir, start, status } = setup(context);
  const run = start("hold");
  await waitFor(() => status().startsWith("working"));
  const followUp = spawn(process.execPath, [broker, "follow-up", runDir, "late"], { env: { ...process.env }, windowsHide: true });
  let acknowledgement = "";
  followUp.stdout.on("data", (chunk) => (acknowledgement += chunk));
  const followUpExit = new Promise((done) => followUp.on("exit", done));
  await new Promise((wake) => setTimeout(wake, 300));
  writeFileSync(join(root, "release"), "");

  assert.equal(await followUpExit, 0);
  assert.equal(acknowledgement.trim(), "follow_up started");
  assert.equal(await run.exited, 0, run.output);
  assert.match(run.output, /settled t2 .*\r?\nreply:late\r?\n$/);
});

test("an abort that cancels work without an aborted reply exits as aborted", { timeout: 20000 }, async (context) => {
  const { runDir, start, cli, status } = setup(context);
  const run = start("hold");
  await waitFor(() => status().startsWith("working"));
  assert.equal(cli("abort", runDir).stdout.trim(), "abort done");
  assert.equal(await run.exited, 2, run.output);
  assert.match(status(), /^aborted t0 /);
});

test("an interrupted run keeps its session, blocks a second writer, and resumes", { timeout: 20000 }, async (context) => {
  const { start, status } = setup(context);
  const first = start("hold", "--", "--model", "fake/m");
  await waitFor(() => status().startsWith("working"));

  const second = start("recall");
  assert.equal(await second.exited, 1);
  assert.match(second.output, /already live/);

  first.kill();
  await first.exited;
  await waitFor(() => status().startsWith("interrupted"));

  const resumed = start("recall");
  assert.equal(await resumed.exited, 0, resumed.output);
  assert.match(resumed.output, /^resumed; previous run interrupted at t0$/m);
  assert.match(resumed.output, /^ready fake\/m thinking=off messages=1$/m);
  assert.match(resumed.output, /^reply:recall prior=hold$/m);
});

test("official and npm Windows shims resolve a CLI path containing spaces", (context) => {
  const { root, runDir } = setup(context);
  const shim = join(root, "pi shim.cmd");
  writeFileSync(join(root, "pi cli.js"), fakePi);
  for (const prefix of ["%~dp0", "%dp0%/"]) {
    writeFileSync(shim, `@ECHO off\nnode "${prefix}pi cli.js" %*\n`);
    const result = spawnSync(process.execPath, [broker, "run", runDir, "--cwd", root, "hello"], {
      env: { ...process.env, PI_BIN: shim }, encoding: "utf8", windowsHide: true, timeout: 10000,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(render(result.stdout), /^reply:hello$/m);
  }
});

test("a Pi launch failure ends the run with an error", (context) => {
  const { root, runDir, cli } = setup(context);
  const result = spawnSync(process.execPath, [broker, "run", runDir, "--cwd", root, "hello"], {
    env: { ...process.env, PI_BIN: join(root, "missing-pi.exe") },
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(cli("status", runDir).stdout, /^error t0 · .*(ENOENT|not found)/);
  assert.ok(!existsSync(join(runDir, "final.md")));
});
