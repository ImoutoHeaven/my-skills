---
name: colab-attach-ssh
description: Attach the Google Colab CLI to an already-running runtime, including an unregistered browser session, connect with SSH, and recover from a missing SSH key. Use when operating or troubleshooting an existing Colab VM through SSH.
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
