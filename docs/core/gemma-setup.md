# `gemini gemma` — Automated Local Model Routing Setup

Local model routing uses a local Gemma 3 1B model running on your machine to
classify and route user requests. It routes simple requests (like file reads) to
Gemini Flash and complex requests (like architecture discussions) to Gemini Pro.

<!-- prettier-ignore -->
> [!NOTE]
> This is an experimental feature currently under active development.

## What is this?

This feature saves cloud API costs by using local inference for task
classification instead of a cloud-based classifier. It adds a few milliseconds
of local latency but can significantly reduce the overall token usage for hosted
models.

## Quick start

```bash
# One command does everything: downloads runtime, pulls model, configures settings, starts server
gemini gemma setup
```

You'll be prompted to accept the Gemma Terms of Use. The model is ~1 GB.

After setup, **just use the CLI normally** — routing happens automatically on
every request.

## Docker Compose

The repository includes
[`docker-compose.gemma.yml`](../../docker-compose.gemma.yml) for running Gemini
CLI and its local LiteRT-LM router in a container. From the directory containing
the Compose file, run:

```bash
# Downloads the LiteRT-LM runtime and model, and configures this workspace.
docker compose -f docker-compose.gemma.yml run --rm gemini-cli gemma setup

# Starts Gemini CLI; the local model server starts automatically.
docker compose -f docker-compose.gemma.yml run --rm gemini-cli
```

Setup interactively prompts you to accept the
[Gemma Terms of Use](https://ai.google.dev/gemma/terms) before downloading the
model. The Compose service keeps the CLI's home directory (including the
downloaded runtime and model) in a named volume and mounts the current directory
as its workspace. Set `GEMINI_API_KEY` in your shell if using API-key
authentication; otherwise, authenticate interactively and the credentials are
retained in the home volume.

The current `gemini gemma setup` installer supports Linux x86_64 only. The
LiteRT server runs inside the same container as Gemini CLI, so no host port
mapping is needed.

## Commands

| Command               | What it does                                                   |
| --------------------- | -------------------------------------------------------------- |
| `gemini gemma setup`  | Full install (binary + model + settings + server start)        |
| `gemini gemma status` | Health check — shows what's installed and running              |
| `gemini gemma start`  | Start the LiteRT server (auto-starts on CLI launch by default) |
| `gemini gemma stop`   | Stop the LiteRT server                                         |
| `gemini gemma logs`   | Tail the server logs to see routing requests live              |
| `/gemma`              | In-session status check (type it inside the CLI)               |

## Verifying it works

1. Run `gemini gemma status` — all checks should show green
2. Open two terminals:
   - Terminal 1: `gemini gemma logs` (watch for incoming requests)
   - Terminal 2: use the CLI normally
3. You should see classification requests appear in the logs as you interact
   with the CLI
4. The `/gemma` slash command inside a session shows a quick status panel

## Setup flags

```bash
gemini gemma setup --port 8080      # custom port
gemini gemma setup --no-start       # don't start server after install
gemini gemma setup --force           # re-download everything
gemini gemma setup --skip-model     # binary only, skip the 1GB model download
```

## How it works under the hood

- Local Gemma classifies each request as "simple" or "complex" (~100ms)
- Simple → Flash, Complex → Pro
- If the local server is down, the CLI silently falls back to the cloud
  classifier — no errors, no disruption

## Disabling

Set `enabled: false` in settings or just run `gemini gemma stop` to turn off the
server:

```json
{ "experimental": { "gemmaModelRouter": { "enabled": false } } }
```

## Advanced setup

If you are in an environment where the `gemini gemma setup` command cannot
automatically download binaries (for example, behind a strict corporate
firewall), you can perform the setup manually.

For more information, see the
[Manual Local Model Routing Setup guide](./local-model-routing.md).
