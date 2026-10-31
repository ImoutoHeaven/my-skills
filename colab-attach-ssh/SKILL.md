---
name: colab-attach-ssh
description: Attach to an existing Google Colab runtime, operate it over SSH, transfer files directly with the Colab CLI or SCP, and recover a missing SSH key. Use for operating, transferring files to or from, or troubleshooting an existing Colab VM.
---

# Attach to an existing Colab runtime via SSH

This workflow uses an authenticated `google-colab-cli`, Python, OpenSSH (`ssh` and `ssh-keygen`), and a shell or execution tool that can provide a PTY. It does not require a particular operating system, machine-specific path, agent, or terminal tool. If the CLI is missing, the official installation option is `uv tool install google-colab-cli`; see [its documentation](https://github.com/googlecolab/google-colab-cli) for alternatives and account authorization. Use the Google account that owns or can access the target runtime.

## Find and register the active runtime

1. Run `colab sessions`. An entry marked `[?]` is an active assignment without a local CLI alias. Endpoints are ephemeral: discover the current one rather than using an old value. If multiple runtimes exist, identify the one attached to the user's notebook; do not guess. If none exists, report that the intended notebook runtime must first be started.
2. If the intended endpoint has no local alias, run the bundled `scripts/attach.py` using a Python environment containing `google-colab-cli`. From this skill directory:

   ```bash
   python scripts/attach.py --endpoint 'CURRENT_ENDPOINT' --name colab-attached
   ```

   `--endpoint` may be omitted only when exactly one assignment is active. If the CLI is isolated in a `uv` tool environment and `python` cannot import `colab_cli`, an alternative is:

   ```bash
   uv run --no-project --with 'google-colab-cli==CLI_VERSION' python scripts/attach.py --endpoint 'CURRENT_ENDPOINT' --name colab-attached
   ```

   Replace `CLI_VERSION` with the installed version from `colab version`. For non-default CLI settings, pass the same `--auth`, `--config`, and `--client-oauth-config` values to the script and to subsequent `colab` commands. The script queries active assignments and registers the selected one in local CLI state; it does not allocate, stop, or restart a VM. It refuses to overwrite an alias pointing to a different active assignment. If the endpoint is stale, ambiguous, or the alias conflicts, inspect the current sessions and resolve it before proceeding. The script uses CLI Python APIs, which can change with CLI versions.
3. Run `colab sessions` again and confirm the alias still maps to the intended endpoint. Some CLI versions auto-create a VM if `colab ssh -s NAME` receives a missing alias, including in proxy mode. Do not invoke SSH on an unverified alias; if the runtime vanishes between verification and connection, stop and inspect any auto-creation message. Never use `--rm` for a session the user wants to keep.

## Connect and operate

In an interactive terminal or a persistent PTY-capable tool, use the verified alias and a local Ed25519 or ECDSA private-key path:

```bash
colab ssh -s colab-attached --identity "$HOME/.ssh/colab-recovery"
```

Replace the example alias and identity with the actual values; do not print or copy private-key contents. The command remains running while the SSH shell is open. Wait for its prompt, issue remote commands in that **same** PTY/session, and read their output before sending another command. Close the shell with `exit` when finished; that does not intentionally stop the runtime. If the local tool represents a PTY as a task, send input and the Enter key to that same task rather than starting a new local shell for each remote command.

SSH uses the Colab runtime-proxy connection; the endpoint identifier is not a public SSH hostname. A notebook's long-running foreground cell may keep its Python kernel busy, while SSH remains a separate channel. Preserve such cells and long-running work; use the application's own restart controls when available.

## Transfer files directly

Use the authenticated Colab connection for local-to-runtime and runtime-to-local transfers. Do not upload files to public temporary storage services as a transfer workaround; use an explicitly authorized external destination only when the user requests one. Before each transfer, verify the alias with `colab sessions` as above: missing aliases can cause some CLI versions to allocate a new runtime. Use the same CLI authentication and config options as the attached session.

For individual files, the CLI supports both directions:

```bash
colab upload -s colab-attached '/path/to/local-file' '/content/remote-file'
colab download -s colab-attached '/content/remote-file' '/path/to/local-copy'
```

Quote paths, use a new temporary destination when overwriting would be unsafe, and verify size and a cryptographic digest on both ends when the result matters. CLI transfers may wait on a busy notebook kernel; do not restart the kernel to unblock them. On Windows Git Bash, prefix these commands with `MSYS_NO_PATHCONV=1` so `/content/...` remains a remote POSIX path. Use the shell's equivalent when Git Bash is not in use.

If an SSH channel is available, OpenSSH `scp` can transfer files over the CLI's proxy without a public server. Disconnect an existing interactive SSH channel first if the runtime allows only one SSH connection; then recheck `colab sessions`. This example uses a temporary host label, the verified alias, and the same identity for the proxy and SSH. Adapt paths and quoting for the local shell; do not use `--rm`.

```bash
scp -o 'ProxyCommand=colab ssh --proxy-mode -s colab-attached --identity /path/to/private-key' \
    -o StrictHostKeyChecking=accept-new -i '/path/to/private-key' \
    '/path/to/local-file' 'root@colab-runtime:/content/remote-file'
scp -o 'ProxyCommand=colab ssh --proxy-mode -s colab-attached --identity /path/to/private-key' \
    -o StrictHostKeyChecking=accept-new -i '/path/to/private-key' \
    'root@colab-runtime:/content/remote-file' '/path/to/local-copy'
```

`root@colab-runtime` is an SSH host label for the proxy, not the runtime endpoint. On Windows Git Bash, keep local paths and `/content/...` distinct and test path handling; prefer `MSYS_NO_PATHCONV=1` if argument rewriting interferes. For directories, use SCP's recursive option only after checking source and destination; avoid unintended overwrites. On a runtime where the account requires a different SSH user, use that user instead of `root`. Proxy logs and error output may contain connection credentials: inspect them carefully and never paste them into reports.

## Recover a lost or unusable SSH key

First distinguish a missing local SSH key from missing Google account access: a new SSH key still requires an authorized account and access to the existing runtime. Do not overwrite another key. In a POSIX shell, choose a new filename that does not exist, then generate an Ed25519 pair:

```bash
mkdir -p "$HOME/.ssh"
test ! -e "$HOME/.ssh/colab-recovery" || { echo 'Choose a different unused key filename'; exit 1; }
ssh-keygen -t ed25519 -f "$HOME/.ssh/colab-recovery"
```

Use the platform's equivalent path and commands on other shells. Choose a passphrase according to the user's security and automation needs. Recheck the active alias, then connect with `--identity` pointing to the new private key. The CLI derives its public key and passes it during connection. On a current SSH-enabled Colab runtime, a newly generated key was verified to connect to the same VM after the original local private key was removed; no notebook reset, VM restart, or manual modification of `authorized_keys` was needed.

This is **recovery of access**, not proof that the old key was revoked. If an old private key may have been exposed, use the relevant provider/account security and revocation procedures; do not claim that generating a new key invalidates it. Some runtimes or CLI versions may lack SSH support or behave differently.

## Troubleshoot

- Missing or changed alias: repeat discovery and register the actual live endpoint. Do not create or replace a runtime to resolve an alias issue unless explicitly requested.
- `no SSH public key found`: use an existing valid identity with `--identity`, or follow the key-recovery steps above. Do not inspect private-key contents.
- HTTP 429: another SSH session may be active. Identify its owner and reuse or release it with authorization; do not kill it blindly.
- HTTP 401/403: check Google CLI login, account, and access to the runtime. An unrelated application API key is not a Colab login.
- HTTP 404: verify the live endpoint and SSH support; a different runtime or CLI/server version may behave differently.
- Still `running`: an interactive SSH shell is expected to remain running. Continue through the same PTY, then use `exit`.

Do not log proxy credentials, SSH private keys, model-download tokens, or notebook Secrets. Shell output and terminal transcripts can be retained by tools; use an authorized secret mechanism rather than placing credentials directly in commands.
