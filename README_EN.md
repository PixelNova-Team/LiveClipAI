# LiveClipAI

> AI-powered live stream highlight clipper. Monitor live streams in real-time, automatically detect highlights, clip and publish to social platforms.

[![Electron](https://img.shields.io/badge/Electron-33-47848F.svg)](https://www.electronjs.org/)
[![Vue 3](https://img.shields.io/badge/Vue-3-brightgreen.svg)](https://vuejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6.svg)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-Apache%202.0-green.svg)](LICENSE)

[中文](README.md)

<!-- TODO: Add screenshots -->

---

## Features

- **Multi-platform monitoring** — Bilibili, Douyin, Douyu, Huya, Kuaishou
- **Real-time danmaku collection** — WebSocket-based bullet comments for highlight scoring
- **Three-track architecture** — Recording + Analysis + Slicing run in parallel with zero gaps
- **Multi-signal AI scoring** — Danmaku density + Audio energy + ASR keywords fusion
- **Double-confirm state machine** — Two consecutive threshold hits required, reduces false positives
- **Local Whisper ASR** — Offline speech recognition, data stays on your machine
- **AI title generation** — Compatible with any OpenAI-format API (Qwen, Claude, Gemini, Ollama, etc.)
- **One-click publish** — Playwright-based auto-publish to Douyin, Bilibili, Kuaishou
- **Plugin architecture** — Add a new platform in 3 files, no core code changes needed

---

## Supported Platforms

| Platform | Monitor | Danmaku | Publish | Protocol |
|----------|:-------:|:-------:|:-------:|----------|
| Bilibili | ✅ | ✅ | ✅ | WebSocket binary (brotli/zlib) |
| Douyin   | ✅ | ✅ | ✅ | WebSocket |
| Douyu    | ✅ | ✅ | — | WebSocket STT |
| Huya     | ✅ | ✅ | — | WebSocket Tars binary |
| Kuaishou | ✅ | ✅ | ✅ | HTTP polling (GraphQL) |
| YouTube  | Planned | — | — | — |

---

## Architecture

```
┌──────────────────────────────────────────────┐
│          LiveMonitor Orchestrator             │
│  Parse URL → Get stream + room ID → Start    │
└──────┬──────────────┬──────────────┬─────────┘
       │              │              │
  ┌────▼────┐   ┌─────▼─────┐  ┌────▼──────┐
  │Recorder │   │ Analyzer  │  │SliceWorker │
  │ FFmpeg  │   │ Scoring   │  │ Cut + ASR  │
  │ stream  │   │ Engine    │  │ + AI Title │
  └────┬────┘   └─────┬─────┘  └────┬──────┘
       │              │              │
  Continuous     Multi-signal    Event-driven
  recording      state machine   slice pipeline
```

**Burst Detection State Machine:**

```
IDLE ──score>threshold──▶ HEATING ──score>threshold(2nd)──▶ BURST
  ▲                         │                                  │
  └──score<threshold────────┘                          score<threshold
     (false alarm)                                             │
                                                     COOLING◀─┘
                                                        │
                                          score<threshold(2nd)
                                                        │
                                          emit BurstEvent → IDLE
```

---

## Quick Start

### Prerequisites

- [Node.js 18+](https://nodejs.org/)
- [FFmpeg](https://ffmpeg.org/) — macOS: `brew install ffmpeg`

### Install

```bash
git clone https://github.com/PixelNova-Team/LiveClipAI.git
cd LiveClipAI
npm install
```

### Development

```bash
npm run dev
```

### Build

```bash
# macOS
npm run package:mac

# Windows (requires FFmpeg setup, see below)
npm run package:win
```

### Windows FFmpeg Setup

Windows builds need a static FFmpeg binary:

1. Download from [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) (get the `essentials` build)
2. Place `ffmpeg.exe` at `static/ffmpeg/win/ffmpeg.exe`

macOS uses the `ffmpeg-static` npm package automatically.

---

## Configuration

The app generates a default config on first launch. All settings can also be changed in the Settings page.

- macOS: `~/Library/Application Support/LiveClipAI/config.yaml`
- Windows: `%APPDATA%/LiveClipAI/config.yaml`

### AI Provider

Supports any OpenAI-compatible API:

```yaml
ai:
  active_provider: qwen
  providers:
    qwen:
      base_url: https://dashscope.aliyuncs.com/compatible-mode/v1
      api_key: your-api-key
      model: qwen-plus
    openai:
      base_url: https://api.openai.com/v1
      api_key: sk-xxx
      model: gpt-4o-mini
```

### ASR (Speech Recognition)

| Provider | Description | Config |
|----------|-------------|--------|
| `whisper-local` | Local whisper.cpp, offline | Default, no config needed |
| `volcengine` | Volcengine streaming ASR | Requires `app_id` + `access_token` |
| `paraformer` | Alibaba Paraformer API | Requires `api_key` |

### Scoring Weights

| Setting | Description | Default |
|---------|-------------|---------|
| `slice.danmaku_weight` | Danmaku density weight | `0.45` |
| `slice.audio_weight` | Audio energy weight | `0.25` |
| `slice.ai_weight` | ASR keyword weight | `0.30` |
| `slice.burst_threshold` | Burst trigger threshold (0-1) | `0.6` |
| `slice.pre_buffer` | Seconds before burst to include | `5` |
| `slice.post_buffer` | Seconds after burst to include | `3` |

---

## Project Structure

```
LiveClipAI/
├── src/
│   ├── main/                    # Main process (TypeScript)
│   │   ├── index.ts             # App entry
│   │   ├── ipc.ts               # IPC handler layer
│   │   ├── live-monitor.ts      # Three-track orchestrator
│   │   ├── recorder.ts          # Recording track (FFmpeg)
│   │   ├── scoring-engine.ts    # Multi-signal scoring engine
│   │   ├── burst-detector.ts    # Burst state machine
│   │   ├── slice-worker.ts      # Slice pipeline
│   │   ├── ai-client.ts         # LLM client (title gen, scoring)
│   │   ├── whisper-local.ts     # Local Whisper ASR
│   │   ├── auth-manager.ts      # Platform cookie management
│   │   ├── asr/                 # ASR providers
│   │   └── plugins/
│   │       ├── platform/        # Platform plugins (5 built-in)
│   │       ├── danmaku/         # Danmaku collector plugins
│   │       └── publisher/       # Auto-publish plugins
│   ├── preload/                 # Electron preload
│   └── renderer/                # Frontend (Vue 3 + Element Plus)
├── plugins.config.json          # Plugin registry + platform config
├── electron-builder.yml         # Build config
└── package.json
```

---

## Adding a New Platform

LiveClipAI uses a plugin system. To add a new platform, create 3 files:

**1. Platform plugin** — `src/main/plugins/platform/<name>.ts`

```typescript
import type { PlatformPlugin, LiveInfo } from './types'

export const mysitePlatform: PlatformPlugin = {
  name: 'mysite',
  label: 'My Site',
  icon: 'mysite',

  validateUrl: (url) => url.includes('mysite.com'),
  getLiveInfo: async (url): Promise<LiveInfo> => { /* ... */ },
  getStreamUrl: async (url): Promise<string> => { /* ... */ },
  isLive: async (url): Promise<boolean> => { /* ... */ },
  getLoginUrl: () => 'https://mysite.com/login',
  getHeaders: () => ({}),
}
```

**2. Danmaku collector** — `src/main/plugins/danmaku/<name>.ts` (implement `DanmakuCollector`)

**3. Register** — Add entries to `plugins.config.json` and `src/main/plugins/loader.ts`

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop | Electron 33, electron-vite |
| Frontend | Vue 3, TypeScript, Element Plus |
| Backend | TypeScript, Node.js |
| AI/ASR | whisper.cpp (local), OpenAI-compatible API |
| Media | FFmpeg, ffmpeg-static |
| Danmaku | WebSocket (ws), Tars protocol |
| Storage | SQLite (better-sqlite3), YAML |
| Publish | Playwright |
| i18n | vue-i18n (zh-CN / en) |

---

## Notes

- **Auto-publish** uses Playwright browser automation. Log in to each platform via the app's built-in browser first.
- **Local Whisper** downloads the model on first use (~145MB for `base`). Ensure network access.
- **Huya danmaku** uses a BrowserWindow approach — requires a logged-in Huya account.
- Scoring weights are **auto-redistributed** when a signal is unavailable (e.g., no danmaku → audio+ASR split the weight).

---

## Contributing

1. Fork this repo
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Submit a Pull Request

---

## License

[Apache License 2.0](LICENSE)
