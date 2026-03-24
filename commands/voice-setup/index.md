---
description: Install voice transcription dependencies (whisper.cpp + ffmpeg) for claude2bot.
allowed-tools:
  - AskUserQuestion
  - Read
  - Bash(brew *)
  - Bash(winget *)
  - Bash(choco *)
  - Bash(apt *)
  - Bash(which *)
  - Bash(where *)
  - Bash(whisper-cli *)
  - Bash(node *)
  - Bash(ffmpeg *)
  - Bash(mkdir *)
---

# claude2bot Voice Setup

Install and verify voice transcription dependencies.

**Plugin root**: `${CLAUDE_PLUGIN_ROOT}`
**Data directory**: `${CLAUDE_PLUGIN_DATA}`

## 1. Detect Platform

Check `process.platform` or use system commands:
- **macOS**: `uname -s` → Darwin
- **Linux**: `uname -s` → Linux
- **Windows**: `where` exists, or Git Bash environment

## 2. Check Existing Installs

Check if dependencies are already available:

```bash
# ffmpeg
which ffmpeg || where ffmpeg

# whisper
which whisper-cli || which whisper || where whisper-cli || where whisper
```

Report what's found and what's missing.

## 3. Install Missing Dependencies

### macOS (Homebrew)
```bash
brew install ffmpeg
brew install whisper-cpp
```
After install, `whisper-cli` will be in PATH.

### Windows (winget or manual)
```bash
# ffmpeg
winget install Gyan.FFmpeg

# whisper.cpp — no winget package, guide manual build:
```
For whisper.cpp on Windows, inform the user:
```
whisper.cpp needs to be built from source on Windows:
  1. git clone https://github.com/ggerganov/whisper.cpp
  2. cd whisper.cpp && cmake -B build && cmake --build build --config Release
  3. Binary: build/bin/Release/whisper-cli.exe

Or download a pre-built release from:
  https://github.com/ggerganov/whisper.cpp/releases
```

Ask the user for the whisper binary path if not in PATH:
```
whisper-cli not found in PATH.
Enter the full path to whisper-cli (or 'skip' to configure later):
```

### Linux (apt)
```bash
sudo apt install ffmpeg
```
For whisper.cpp, same manual build instructions as Windows.

## 4. Download Model (if needed)

Check if whisper has a default model. If the user needs one:
```
whisper.cpp requires a GGML model file.
Recommended: ggml-large-v3-turbo.bin (~1.5GB, best accuracy)
Alternatives: ggml-base.bin (~150MB, faster, lower accuracy)

Download a model? (large-v3-turbo / base / skip)
```

If yes, provide the download command:
```bash
# macOS/Linux
curl -L -o /usr/local/share/whisper/ggml-large-v3-turbo.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
```

On macOS with Homebrew, whisper-cli includes a default model — skip this step.

## 5. Verify

Run a quick test to confirm everything works:

```bash
# Check ffmpeg
ffmpeg -version

# Check whisper
whisper-cli --help
```

## 6. Update Config

Read `${CLAUDE_PLUGIN_DATA}/config.json` and update voice settings:

```json
{
  "voice": {
    "enabled": true,
    "command": "whisper-cli",
    "model": "/path/to/model.bin",
    "language": "auto"
  }
}
```

- If whisper is in PATH: `command` can be omitted (auto-detect)
- If not in PATH: set `command` to the full binary path
- If model was downloaded: set `model` to the file path
- If Homebrew default model: omit `model`

## 7. Done

```
Voice transcription setup complete!

  ffmpeg:    ✓ installed
  whisper:   ✓ whisper-cli (homebrew)
  model:     ✓ default / ggml-large-v3-turbo.bin
  language:  auto

Voice messages on Discord/Telegram will be automatically transcribed.
```
