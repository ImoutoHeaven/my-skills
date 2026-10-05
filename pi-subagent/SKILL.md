---
name: pi-subagent
license: MIT
description: Delegate a bounded task to the locally installed Pi coding agent as a background subagent with progress, steering, follow-ups, and session resume. Use when a task should be delegated to Pi while the parent agent retains scope, authorization, and verification. Do not use when delegation is unnecessary or forbidden.
---

# Pi Subagent

The parent agent keeps task scope, permissions, result review, and user communication. Pi does the delegated work.

Requires Node.js and a locally installed [Pi coding agent](https://pi.dev) with RPC support (`prompt`, `get_state`, `abort`, and `agent_settled`) and authentication for the selected provider. Use a Node.js version supported by your Pi installation. The broker uses only Node.js built-ins. Shell examples use Bash; adapt redirection and background launching to your host shell.

## Choose the mode

- One independent request whose final text is sufficient: `pi --print --no-session -- "<prompt>" < /dev/null` (Bash).
- Longer work, or work that needs progress, steering, follow-ups, or resume: the broker below.

Print mode reads piped stdin until EOF. With no piped input, redirect from `/dev/null` or have the launcher close stdin; leaving a pipe open makes Pi wait before processing the prompt.

Provider and model are launch inputs. Forward a caller's choice unchanged through `--provider` and `--model`; otherwise use Pi's defaults. For direct Pi calls, put these options before the prompt's `--`; for broker calls, put them after the broker's `--`, as shown below. `--provider` also requires `--model`. For explicit selection, use `pi --list-models <search>`, then `pi auth check --provider <provider>` or `pi auth check --model <provider/model>`. Authentication checks require an exact provider or provider/model identifier, even when launch accepts a fuzzy model name. Keep credentials out of prompts, logs, and arguments.

## Run the broker in the background

The broker is [scripts/pi-subagent-broker.mjs](scripts/pi-subagent-broker.mjs). It finds Pi on `PATH`, including official-installer and npm Windows `.cmd` shims. For a nonstandard installation or wrapper, set `PI_BIN` to the Pi executable or CLI JavaScript entry. One run directory holds one Pi session for one delegated task. Place it outside the publishable source tree, for example in the operating system's temporary directory: it contains local paths, prompts, responses, and session data that should not be committed. Write the delegation contract to a file and start:

```text
node "<skill-dir>/scripts/pi-subagent-broker.mjs" run "<run-dir>" --cwd "<project-dir>" - -- <Pi options> < "<contract-file>"
```

Launch every `run` as a background job. The run exits when the subagent settles. Use the first launcher available:

1. The host's managed background-task API: start the run, retain its job handle, and poll output and exit status using bounded waits within the API's limits. The task's exit is the completion signal. Continue independent work meanwhile and read new output at work milestones. Stop a run with the broker's `abort`; killing the task counts as a crash, which `status` reports as `interrupted` and a later `run` resumes.
2. Bash/POSIX shell `&` as the fallback, when the host allows processes to outlive the launching command: create the run directory with `mkdir -p "<run-dir>"`, then start `nohup <run command> > "<run-dir>/run.out" 2>&1 &`. Keep the contract's stdin redirection in the run command. Wait with a bounded loop inside one foreground command, sized to the shell tool's timeout:

   ```text
   for i in $(seq 10); do node "<skill-dir>/scripts/pi-subagent-broker.mjs" status "<run-dir>" | grep -qE '^(starting|working)' || break; sleep 20; done; node "<skill-dir>/scripts/pi-subagent-broker.mjs" status "<run-dir>"
   ```

   Confirm the launch with `status` in a separate tool invocation. If no run is found or it is interrupted, inspect `run.out`; a host that terminates background children requires a managed background-task API instead. Repeat the loop until `status` leaves both `starting` and `working`, then inspect the terminal status and read `<run-dir>/final.md` for a settled result.

The message argument is `-` (stdin) or inline text. Pi options after `--` cover model, thinking, tools, extensions, and context files; the broker owns `--mode` and every session flag.

Output lines:

- `ready <provider/model> thinking=<level> messages=<n>`: Pi is up; `messages` counts the resumed session history.
- `current: running · turn N · tool-calling (edit) · last event 12s ago`: current turn and observed phase. Other phases include waiting for the model, thinking, streaming a reply, preparing a tool call, retrying, and compacting. Concurrent tools are listed together; arguments and reasoning text are omitted.
- `[tN] <text>`: the subagent's narration during turn N, on one line, truncated to 300 characters.
- `steer queued`, `follow_up queued|started`, `ui <dialog> cancelled: <title>`, `retry <n>/<max>: <error>`, `extension error: <error>`.
- Final line: `settled tN → <run-dir>/final.md` (exit 0) or `aborted tN → …` (exit 2), each followed by the full final reply; or `error …` (exit 1), with Pi's stderr tail when Pi itself exited.

`current:` is printed at startup, turn starts, phase changes, and after about 10 seconds without another output line. A heartbeat reports the last observed phase, not proof of model or tool progress. `last event` measures time since a received Pi RPC record; heartbeats do not reset it. Shorter polls can still return `(no new output)`, which alone is not evidence of a stall. A turn is one model response plus its tool calls, not one user request.

The broker appends the same lines to `<run-dir>/progress.log`. `status <run-dir>` prints one line: `working tN · <phase> · last event <seconds>s ago`, `starting`, `settled`, `aborted`, `interrupted`, or `error`. Live status uses the current turn number; terminal `tN` counts completed turns, so an interrupted turn may not be included. These serve the `&` fallback and post-crash inspection.

## Steer, follow up, abort

While a run is live:

```text
node "<skill-dir>/scripts/pi-subagent-broker.mjs" steer "<run-dir>" "<updated direction>"
node "<skill-dir>/scripts/pi-subagent-broker.mjs" follow-up "<run-dir>" "<next request>"
node "<skill-dir>/scripts/pi-subagent-broker.mjs" abort "<run-dir>"
```

A steer lands after the current tool calls finish, before the next model call. A follow-up runs after the current work. Each command prints Pi's acknowledgement (for example `steer queued` or `follow_up started`) or exits 1 with the reason. Once the run has exited, continue the conversation with a new background `run` on the same run directory.

## Resume

`<run-dir>` keeps the Pi session and the launch's cwd and Pi options. A later `run <run-dir> <message>` resumes that session with the stored cwd and options; Pi options after `--` replace the stored ones. One run is live per run directory.

After a broker or host crash, `status` reports `interrupted` and the next `run` prints `resumed; previous run interrupted at tN`. The subagent keeps every completed message and tool result; the reply that was streaming at the crash is lost, so the resume message states where to pick up.

## Define the delegation contract

Give Pi a compact contract:

```text
Goal: <observable outcome>
Scope: <files, directories, or systems in bounds>
Constraints: <permissions, writable paths, compatibility, and prohibited side effects>; do the work yourself, without launching Pi subagents or other Pi processes; stop background jobs you start before returning
Verification: <checks that demonstrate completion>
Return: <result, changed files, checks run, and blockers>
```

Run the subagent with Pi's default configured tools, extensions, skills, and context files for its working directory. Express scope and read-only limits in `Constraints`. Keep the template's fixed `Constraints` clauses in every contract to prohibit recursive delegation and require background-job cleanup. The child does not need this skill loaded to perform its task. Add `--tools`, `--no-tools`, or `--no-extensions` only when the caller asks for a hard restriction.

## Finish and verify

1. Read the final reply from the job output or `<run-dir>/final.md`.
2. Verify material claims independently in the parent environment.
3. Treat `error`, `aborted`, and `interrupted` as incomplete work; keep `progress.log`, `stderr.log`, and the session for diagnosis.
4. Delete the run directory once the result is verified and the delegated task is complete.
