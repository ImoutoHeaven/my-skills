#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, fstatSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, extname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

const usage = `Usage:
  pi-subagent-broker.mjs run <run-dir> [--cwd <dir>] <message...|-> [-- <pi-options...>]
  pi-subagent-broker.mjs steer <run-dir> <message...|->
  pi-subagent-broker.mjs follow-up <run-dir> <message...|->
  pi-subagent-broker.mjs abort <run-dir>
  pi-subagent-broker.mjs status <run-dir>

'run' resumes the run directory's Pi session and exits when the session settles.
Use '-' as the message to read it from stdin. Set PI_BIN to an executable or
Pi CLI JavaScript entry when Pi is outside PATH.`;

const SESSION_FLAGS = ["--mode", "--print", "-p", "--no-session", "--session", "--session-id", "--session-dir", "--continue", "-c", "--resume", "-r", "--fork"];
const DIALOGS = ["select", "confirm", "input", "editor"];
const LIVE = ["starting", "working"];
const PROGRESS_CHARS = 300;

function die(message) {
  throw new Error(message);
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function npmCliFromCmd(cmdPath) {
  const base = dirname(cmdPath);
  const text = readFileSync(cmdPath, "utf8");
  for (const match of text.matchAll(/"([^"\r\n]+\.js)"/gi)) {
    const candidate = resolve(match[1].replace(/%(?:~dp0|dp0%)[\\/]?/gi, `${base}/`));
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function launchFor(path) {
  const extension = extname(path).toLowerCase();
  if ([".js", ".mjs", ".cjs"].includes(extension)) return { command: process.execPath, prefix: [resolve(path)] };
  if (extension === ".cmd") {
    const cli = npmCliFromCmd(resolve(path));
    if (cli) return { command: process.execPath, prefix: [cli] };
    die(`Cannot safely launch ${path}; set PI_BIN to Pi's executable or CLI JavaScript entry`);
  }
  return { command: path, prefix: [] };
}

function resolvePiLaunch() {
  if (process.env.PI_BIN) return launchFor(process.env.PI_BIN);
  if (process.platform !== "win32") return { command: "pi", prefix: [] };
  const pathEntries = (process.env.PATH || "").split(delimiter).filter(Boolean);
  for (const name of ["pi.exe", "pi.cmd"]) {
    for (const directory of pathEntries) {
      if (existsSync(join(directory, name))) return launchFor(join(directory, name));
    }
  }
  die("Pi was not found in PATH; set PI_BIN to Pi's executable or CLI JavaScript entry");
}

const readJson = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null);

function writeJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

const lockOwner = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

// Linking a finished pid file publishes the lock and its owner in one atomic step.
function acquireLock(path) {
  const mine = String(process.pid);
  const temporary = `${path}.${mine}.tmp`;
  writeFileSync(temporary, mine);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        linkSync(temporary, path);
        process.on("exit", () => {
          if (lockOwner(path) === mine) rmSync(path, { force: true });
        });
        return;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      const owner = lockOwner(path);
      if (owner === null) continue;
      if (!/^\d+$/.test(owner) || processAlive(Number(owner))) {
        die(`A run is already live in ${dirname(path)} (lock owner ${owner}); delete ${path} if that process is not a broker`);
      }
      // ponytail: two brokers recovering the same crashed run at the same instant can both pass; add a rename handoff if parallel resumes of one run-dir appear.
      rmSync(path, { force: true });
    }
    die(`Could not lock ${path}`);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function messageFrom(parts) {
  if (parts.length === 1 && parts[0] === "-") return readFileSync(0, "utf8").trim();
  return parts.join(" ").trim();
}

const oneLine = (text, limit) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
};

const assistantText = (message) =>
  Array.isArray(message?.content)
    ? message.content.filter((item) => item.type === "text").map((item) => item.text).join("").trim()
    : "";

function stderrTail(path) {
  if (!existsSync(path)) return "";
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
  return lines.slice(-5).join("\n").slice(-800);
}

function activitySummary(state) {
  const age = state.lastEventAt == null ? "no Pi events yet" : `last event ${Math.max(0, Math.floor((Date.now() - state.lastEventAt) / 1000))}s ago`;
  return `${state.activity || "waiting for Pi"} · ${age}`;
}

function statusLine(runDir) {
  const state = readJson(join(runDir, "state.json"));
  if (!state) die(`No run found: ${runDir}`);
  const alive = processAlive(state.brokerPid);
  const status = LIVE.includes(state.status) && !alive ? "interrupted" : state.status;
  let line = `${status} t${status === "working" ? state.currentTurn ?? state.turns : state.turns}`;
  if (LIVE.includes(status)) line += ` · ${activitySummary(state)}`;
  if (status === "interrupted") line += ` · continue with: run ${runDir} <message>`;
  if (["settled", "aborted"].includes(status)) line += ` → ${join(runDir, "final.md")}`;
  if (status === "error" && state.lastError) line += ` · ${oneLine(state.lastError, 300)}`;
  return { state, alive, line };
}

async function control(type, args) {
  const [directory, ...parts] = args;
  if (!directory) die(usage);
  const runDir = resolve(directory);
  const { alive, line } = statusLine(runDir);
  if (!alive) die(`No live run (${line}); start one with: run ${runDir} <message>`);
  const command = { id: `${type}-${randomUUID()}`, type };
  if (type !== "abort") {
    command.message = messageFrom(parts);
    if (!command.message) die(`${type} requires a message`);
  }
  appendFileSync(join(runDir, "commands.jsonl"), `${JSON.stringify(command)}\n`);
  const deadline = Date.now() + 5000;
  for (;;) {
    const state = readJson(join(runDir, "state.json"));
    const ack = state?.acks?.[command.id];
    if (ack) {
      if (!ack.success) die(`${type} rejected: ${ack.error}`);
      process.stdout.write(`${type} ${ack.disposition || "done"}\n`);
      return;
    }
    if (Date.now() > deadline || !processAlive(state?.brokerPid)) {
      die(`${type} not delivered: the run ended or stopped responding; continue with: run ${runDir} <message>`);
    }
    await new Promise((wake) => setTimeout(wake, 100));
  }
}

function parseRunArgs(args) {
  const separator = args.indexOf("--");
  const head = separator === -1 ? [...args] : args.slice(0, separator);
  const directory = head.shift();
  if (!directory) die(usage);
  let cwd = null;
  if (head[0] === "--cwd") {
    if (!head[1]) die(usage);
    cwd = resolve(head[1]);
    head.splice(0, 2);
  }
  const piArgs = separator === -1 ? null : args.slice(separator + 1);
  const owned = piArgs?.find((value) => SESSION_FLAGS.some((flag) => value === flag || value.startsWith(`${flag}=`)));
  if (owned) die(`The broker owns RPC mode and the session; remove ${owned} from Pi options`);
  const message = messageFrom(head);
  if (!message) die("run requires a message");
  return { runDir: resolve(directory), cwd, piArgs, message };
}

async function run(args) {
  const options = parseRunArgs(args);
  const { runDir, message } = options;
  mkdirSync(runDir, { recursive: true });
  const paths = {
    launch: join(runDir, "launch.json"),
    state: join(runDir, "state.json"),
    commands: join(runDir, "commands.jsonl"),
    progress: join(runDir, "progress.log"),
    stderr: join(runDir, "stderr.log"),
    final: join(runDir, "final.md"),
    session: join(runDir, "session"),
  };

  acquireLock(join(runDir, "lock"));
  const previous = readJson(paths.state);
  const stored = readJson(paths.launch);
  const cwd = options.cwd || stored?.cwd || process.cwd();
  if (stored && stored.cwd !== cwd) die(`${runDir} belongs to ${stored.cwd}; use a new run directory for ${cwd}`);
  const piArgs = options.piArgs || stored?.piArgs || [];
  writeJson(paths.launch, { cwd, piArgs });
  writeFileSync(paths.commands, "");

  let state = {
    status: "starting",
    brokerPid: process.pid,
    piPid: null,
    cwd,
    model: null,
    turns: previous?.turns || 0,
    currentTurn: previous?.turns || 0,
    activity: "starting Pi",
    lastEventAt: null,
    lastText: null,
    lastError: null,
    acks: {},
    updatedAt: null,
  };
  const save = (changes = {}) => {
    state = { ...state, ...changes, updatedAt: new Date().toISOString() };
    writeJson(paths.state, state);
  };
  const redraw = !fstatSync(process.stdout.fd).isFile();
  const clearCurrent = redraw ? "\r\x1b[2K" : "";
  let lastCurrentAt = Date.now();
  const say = (line) => {
    process.stdout.write(`${clearCurrent}${line}\n`);
    appendFileSync(paths.progress, `${line}\n`);
    if (redraw && LIVE.includes(state.status)) reportCurrent(false);
  };
  const reportCurrent = (log = true) => {
    save();
    const line = `current: ${state.status === "working" ? "running" : state.status} · turn ${state.currentTurn} · ${activitySummary(state)}`;
    // Keep terminal progress on one physical row, even when tool names exceed its width.
    const display = process.stdout.isTTY ? `\x1b[?7l${line}\x1b[?7h` : line;
    if (redraw) process.stdout.write(`${clearCurrent}${display}`);
    else if (log) process.stdout.write(`${line}\n`);
    if (log) appendFileSync(paths.progress, `${line}\n`);
    lastCurrentAt = Date.now();
  };
  const setActivity = (activity) => {
    if (state.activity === activity) return;
    state.activity = activity;
    reportCurrent();
  };
  reportCurrent();

  let child;
  try {
    const launch = resolvePiLaunch();
    child = spawn(launch.command, [...launch.prefix, "--mode", "rpc", "--session-dir", paths.session, "--continue", ...piArgs], {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    save({ status: "error", lastError: error.message });
    process.stdout.write(clearCurrent);
    throw error;
  }
  child.stdin.on("error", () => {});
  save({ piPid: child.pid || null });

  const queue = [{ id: "run-prompt", type: "prompt", message }];
  const inFlight = new Set();
  const activeTools = new Map();
  let ready = false;
  let busy = false;
  let gate = null;
  let finished = false;
  let lastStop = null;
  let abortAcked = false;
  let probe = null;
  let probeCount = 0;
  let commandOffset = 0;
  let commandBuffer = "";
  const commandDecoder = new StringDecoder("utf8");
  let resolveExit;
  const exited = new Promise((done) => {
    resolveExit = done;
  });

  const send = (record) => {
    if (child.stdin.writable) child.stdin.write(`${JSON.stringify(record)}\n`);
  };

  const finish = (status, exitCode, line) => {
    if (finished) return;
    finished = true;
    clearInterval(inboxTimer);
    const done = ["settled", "aborted"].includes(status);
    save({ status, lastError: status === "error" ? line : state.lastError });
    if (done) writeFileSync(paths.final, state.lastText || "");
    say(line);
    if (done && state.lastText) say(state.lastText);
    process.exitCode = exitCode;
    if (child.stdin.writable) child.stdin.end();
    setTimeout(() => child.kill(), 3000).unref();
  };

  const quiet = () => ready && !finished && !busy && !gate && !queue.length && !inFlight.size;

  // Broker events can lag Pi (a prompt may start after settling), so Pi's own
  // isStreaming decides the exit. Pi writes events and responses in order.
  const maybeFinish = () => {
    if (!quiet()) return;
    probe = `idle-${++probeCount}`;
    send({ id: probe, type: "get_state" });
  };

  const conclude = () => {
    if (abortAcked || lastStop === "aborted") finish("aborted", 2, `aborted t${state.turns} → ${paths.final}`);
    else if (lastStop === "error") finish("error", 1, `error t${state.turns}: ${state.lastError}`);
    else finish("settled", 0, `settled t${state.turns} → ${paths.final}`);
  };

  // A prompt reaching idle Pi starts a run; hold later prompts until that run
  // begins so they queue behind it.
  const pump = () => {
    while (ready && !finished && queue.length && !gate) {
      const command = queue.shift();
      inFlight.add(command.id);
      if (command.type === "abort") {
        send({ id: command.id, type: "abort" });
        continue;
      }
      const streamingBehavior = command.type === "steer" ? "steer" : "followUp";
      send({ id: command.id, type: "prompt", message: command.message, streamingBehavior });
      if (!busy) gate = command.id;
    }
    maybeFinish();
  };

  // ponytail: single-controller JSONL inbox; use a socket if several controllers must write at once.
  const pollInbox = () => {
    try {
      const content = readFileSync(paths.commands);
      if (content.length <= commandOffset) return;
      commandBuffer += commandDecoder.write(content.subarray(commandOffset));
      commandOffset = content.length;
      let newline;
      while ((newline = commandBuffer.indexOf("\n")) !== -1) {
        const line = commandBuffer.slice(0, newline).trim();
        commandBuffer = commandBuffer.slice(newline + 1);
        if (!line) continue;
        const command = JSON.parse(line);
        if (["steer", "follow_up", "abort"].includes(command.type)) queue.push(command);
      }
      pump();
    } catch (error) {
      say(`inbox error: ${error.message}`);
    }
  };
  const inboxTimer = setInterval(() => {
    pollInbox();
    if (!finished && Date.now() - lastCurrentAt >= 1000) reportCurrent(false);
  }, 100);

  const handle = (event) => {
    if (finished) return;
    state.lastEventAt = Date.now();
    if (event.type === "response" && event.id === "broker-state") {
      if (!event.success) return finish("error", 1, `error: ${event.error || "Pi state request failed"}`);
      const data = event.data || {};
      const model = data.model ? `${data.model.provider}/${data.model.id}` : null;
      save({ model, sessionFile: data.sessionFile || null });
      if ([...LIVE, "interrupted"].includes(previous?.status)) say(`resumed; previous run interrupted at t${previous.turns}`);
      say(`ready ${model || "(no model)"} thinking=${data.thinkingLevel || "off"} messages=${data.messageCount ?? 0}`);
      ready = true;
      pump();
      return;
    }
    if (event.type === "response" && event.id === probe) {
      probe = null;
      if (!event.success || typeof event.data?.isStreaming !== "boolean") {
        finish("error", 1, `error: idle check failed: ${event.error || "no isStreaming in state"}`);
      } else if (!event.data.isStreaming && quiet()) conclude();
      return;
    }
    if (event.type === "response") {
      if (!inFlight.delete(event.id)) return;
      const ack = { success: Boolean(event.success), disposition: event.data?.disposition || null, error: event.error || null };
      const acks = Object.fromEntries([...Object.entries(state.acks).slice(-19), [event.id, ack]]);
      save({ acks });
      const name = event.id.replace(/-[0-9a-f-]{36}$/, "");
      if (!ack.success) say(`${name} rejected: ${ack.error}`);
      else if (event.id !== "run-prompt") say(`${name} ${ack.disposition || "done"}`);
      if (ack.disposition === "started") gate = event.id;
      else if (event.id === gate) gate = null;
      if (ack.success && event.id.startsWith("abort-")) abortAcked = true;
      if (event.id === "run-prompt" && !ack.success) {
        save({ lastError: ack.error });
        lastStop = "error";
      }
      pump();
      return;
    }
    if (event.type === "agent_start") {
      busy = true;
      gate = null;
      abortAcked = false;
      save({ status: "working", activity: "waiting for turn" });
      pump();
      return;
    }
    if (event.type === "turn_start") {
      activeTools.clear();
      state.currentTurn = state.turns + 1;
      state.activity = "waiting for model";
      reportCurrent();
      return;
    }
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update?.type === "thinking_delta") setActivity("thinking");
      else if (update?.type === "text_delta") setActivity("streaming reply");
      else if (update?.type === "toolcall_start") setActivity(`preparing tool call${update.toolName ? ` (${update.toolName})` : ""}`);
      return;
    }
    if (["tool_execution_start", "tool_execution_end"].includes(event.type)) {
      if (event.type === "tool_execution_start") activeTools.set(event.toolCallId, event.toolName);
      else activeTools.delete(event.toolCallId);
      setActivity(activeTools.size ? `tool-calling (${oneLine([...new Set(activeTools.values())].join(", "), 150)})` : "finishing turn");
      return;
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const text = assistantText(event.message);
      lastStop = event.message.stopReason || null;
      if (lastStop === "error") save({ lastError: event.message.errorMessage || "assistant error" });
      if (text) {
        save({ lastText: text });
        say(`[t${state.turns + 1}] ${oneLine(text, PROGRESS_CHARS)}`);
      }
      return;
    }
    if (event.type === "turn_end") {
      save({ turns: state.turns + 1 });
      setActivity("between turns");
      return;
    }
    if (event.type === "agent_settled") {
      busy = false;
      gate = null;
      pollInbox();
      pump();
      return;
    }
    if (event.type === "extension_ui_request" && DIALOGS.includes(event.method)) {
      send({ type: "extension_ui_response", id: event.id, cancelled: true });
      say(`ui ${event.method} cancelled: ${oneLine(event.title || event.message || "", 120)}`);
      return;
    }
    if (event.type === "auto_retry_start") {
      setActivity(`retrying (${event.attempt}/${event.maxAttempts})`);
      say(`retry ${event.attempt}/${event.maxAttempts}: ${oneLine(event.errorMessage || "", 200)}`);
      return;
    }
    if (event.type === "compaction_start") setActivity("compacting");
    if (["compaction_end", "auto_retry_end"].includes(event.type)) setActivity("waiting for model");
    if (event.type === "extension_error") say(`extension error: ${oneLine(event.error || "", 300)}`);
  };

  let outputBuffer = "";
  const outputDecoder = new StringDecoder("utf8");
  child.stdout.on("data", (chunk) => {
    outputBuffer += outputDecoder.write(chunk);
    let newline;
    while ((newline = outputBuffer.indexOf("\n")) !== -1) {
      const line = outputBuffer.slice(0, newline).replace(/\r$/, "");
      outputBuffer = outputBuffer.slice(newline + 1);
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch (error) {
        finish("error", 1, `error: invalid Pi JSONL (${error.message}): ${line.slice(0, 200)}`);
        return;
      }
      handle(event);
    }
  });
  child.stderr.on("data", (chunk) => appendFileSync(paths.stderr, chunk));
  child.on("error", (error) => {
    finish("error", 1, `error: ${error.message}`);
    resolveExit();
  });
  child.on("exit", (code, signal) => {
    if (!finished) {
      const tail = stderrTail(paths.stderr);
      finish("error", 1, `error: Pi exited (code ${code}, signal ${signal}) at t${state.turns}${tail ? `\n${tail}` : ""}`);
    }
    resolveExit();
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => finish("interrupted", 130, `interrupted by ${signal} at t${state.turns}`));
  }

  send({ id: "broker-state", type: "get_state" });
  await exited;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || ["help", "--help", "-h"].includes(command)) return process.stdout.write(`${usage}\n`);
  if (command === "run") return run(args);
  if (command === "steer") return control("steer", args);
  if (["follow-up", "follow_up"].includes(command)) return control("follow_up", args);
  if (command === "abort") return control("abort", args);
  if (command === "status" && args.length === 1) return process.stdout.write(`${statusLine(resolve(args[0])).line}\n`);
  die(`Unknown command: ${command}\n\n${usage}`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
