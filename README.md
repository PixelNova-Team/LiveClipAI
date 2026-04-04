# LiveClipAI — AI 直播高光切片桌面应用

> 跨平台 Electron 桌面应用，实时监控直播、AI 自动识别高光时刻、一键切片并发布到主流短视频平台。原生支持国内五大直播/视频平台，插件化架构易于扩展。

[![Electron](https://img.shields.io/badge/Electron-33-47848F.svg)](https://www.electronjs.org/)
[![Vue 3](https://img.shields.io/badge/Vue-3-brightgreen.svg)](https://vuejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6.svg)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-Apache%202.0-green.svg)](LICENSE)

[English](README_EN.md)

---

## 功能特点

- **多平台直播监控** — 同时监控 Bilibili、抖音、斗鱼、虎牙、快手五大平台直播间
- **实时弹幕采集** — WebSocket 实时弹幕（B站/斗鱼/虎牙/快手），弹幕密度辅助高光定位
- **三轨并行架构** — 录制轨 + 分析轨 + 切片工作轨，零间断实时处理
- **多信号 AI 评分** — 弹幕密度（50%）+ 音频能量（30%）+ ASR 关键词（20%）三维融合
- **双重确认状态机** — 连续两次超阈值才触发，大幅减少误切片
- **本地 Whisper ASR** — 离线语音识别，数据不出本机，支持中英日多语言
- **AI 标题生成** — 兼容 OpenAI / Qwen / Claude / Gemini / 智谱 / Ollama 等任意 API
- **一键发布** — 基于 Playwright 浏览器自动化发布到抖音、B 站、快手（个人使用）
- **插件化平台** — 新增平台只需实现 3 个文件，无需修改核心代码

---

## 截图

<!-- TODO: 添加截图 -->

---

## 系统架构

```
┌─────────────────────────────────────────────────┐
│           LiveMonitor Orchestrator               │
│  解析平台 → 获取直播流 URL + 房间号 → 启动三轨    │
└────────┬──────────────┬──────────────┬───────────┘
         │              │              │
    ┌────▼────┐   ┌─────▼─────┐  ┌────▼─────┐
    │ Recorder│   │ Analyzer  │  │SliceWorker│
    │  录制轨  │   │  分析轨   │  │ 切片工作轨 │
    └────┬────┘   └─────┬─────┘  └────┬─────┘
         │              │              │
    持续录制       多信号实时评分    事件驱动切片
    滚动文件       确认状态机       Whisper + AI 标题
```

**分析轨状态机：**

```
IDLE ─score>阈值─▶ PENDING ─score>阈值(第2次)─▶ BURST ─score<阈值─▶ COOLING ─score<阈值(第2次)─▶ IDLE
                      │                                                                          ↑
                      └─score<阈值─▶ IDLE (虚惊，不切片)                    发出 BurstEvent ────────┘
```

---

## 支持平台

| 平台 | 直播监控 | 弹幕采集 | 自动发布 | 弹幕协议 |
|------|:--------:|:--------:|:--------:|----------|
| Bilibili | ✅ | ✅ | ✅ | WebSocket 二进制 (brotli/zlib) |
| 抖音 (Douyin) | ✅ | ✅ | ✅ | WebSocket |
| 斗鱼 (Douyu) | ✅ | ✅ | — | WebSocket STT 格式 |
| 虎牙 (Huya) | ✅ | ✅ | — | WebSocket Tars 二进制 |
| 快手 (Kuaishou) | ✅ | ✅ | ✅ | HTTP 轮询 (GraphQL) |
| YouTube | 计划中 | — | — | — |

---

## 快速开始

### 前置依赖

- [Node.js 18+](https://nodejs.org/)
- [FFmpeg](https://ffmpeg.org/) — 音视频处理（macOS 用 `brew install ffmpeg`）
- [Python 3.10+](https://www.python.org/) — 本地 Whisper ASR（可选）

### 安装

```bash
git clone https://github.com/pixelNova/LiveClipAI.git
cd LiveClipAI

npm install

# macOS: 重新编译 native 模块
npm run rebuild
```

### Windows FFmpeg

Windows 版需要手动下载 FFmpeg 并放置到指定路径：

1. 从 [ffmpeg.org](https://ffmpeg.org/download.html) 或 [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) 下载 Windows 静态版
2. 将 `ffmpeg.exe` 放入 `static/ffmpeg/win/ffmpeg.exe`

macOS 使用 `ffmpeg-static` 包，无需手动操作。

### 开发模式

```bash
npm run dev
```

### 打包

```bash
# macOS
npm run build:mac

# Windows（需先放置 static/ffmpeg/win/ffmpeg.exe）
npm run build:win
```

---

## 配置说明

应用首次启动会生成默认配置文件。你也可以手动复制示例配置：

```bash
cp config.example.yaml config.yaml
```

### AI 模型配置

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `ai.active_provider` | 当前 AI 提供商 | `qwen` |
| `ai.providers.<name>.base_url` | API 地址（兼容 OpenAI 格式） | — |
| `ai.providers.<name>.api_key` | API Key | — |
| `ai.providers.<name>.model` | 模型名称 | — |

支持任意兼容 OpenAI API 格式的提供商：通义千问、OpenAI、Claude、Gemini、智谱、本地 Ollama 等。

### ASR 配置

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `asr.provider` | ASR 引擎 (`whisper` / `volcengine` / `paraformer`) | `whisper` |
| `asr.whisper.model_size` | Whisper 模型大小 (`tiny`→`large`) | `base` |
| `asr.whisper.language` | 识别语言 (`zh`/`en`/`ja`/`auto`) | `zh` |

### 直播监控配置

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `live.analysis_interval` | 分析循环间隔（秒） | `30` |
| `live.burst_threshold` | 爆点触发阈值（0-1） | `0.6` |
| `live.analysis_depth` | 切片后处理深度 (`light`/`medium`/`full`) | `medium` |
| `live.danmaku_weight` | 弹幕密度权重 | `0.5` |
| `live.audio_weight` | 音频音量权重 | `0.3` |
| `live.keyword_weight` | ASR 关键词权重 | `0.2` |
| `live.pre_extend` | 爆点前扩展秒数 | `5` |
| `live.post_extend` | 爆点后扩展秒数 | `10` |
| `live.custom_keywords` | 自定义关键词及权重 | `{}` |

---

## 项目结构

```
LiveClipAI/
├── src/
│   ├── main/                # 主进程 (TypeScript)
│   │   ├── index.ts         # 应用入口
│   │   ├── ipc.ts           # IPC 接口层
│   │   ├── live-monitor.ts  # 直播监控三轨编排器
│   │   ├── recorder.ts      # 录制轨（FFmpeg segment）
│   │   ├── scoring-engine.ts # 多信号评分引擎
│   │   ├── burst-detector.ts # 爆点双重确认状态机
│   │   ├── slice-worker.ts  # 切片工作轨
│   │   ├── whisper-local.ts # 本地 Whisper ASR
│   │   ├── ai-client.ts     # AI 标题生成客户端
│   │   ├── auth-manager.ts  # 平台登录态管理
│   │   ├── asr/             # ASR 多提供商
│   │   └── plugins/         # 插件系统
│   │       ├── platform/    # 平台插件 (douyin/bilibili/douyu/huya/kuaishou)
│   │       ├── danmaku/     # 弹幕采集插件
│   │       └── publisher/   # 发布插件
│   ├── preload/             # Preload 脚本
│   └── renderer/            # 渲染进程 (Vue 3)
│       └── src/
│           ├── views/       # 页面组件
│           ├── components/  # 通用组件
│           ├── api/         # IPC 调用封装
│           └── i18n/        # 国际化 (中文/English)
├── static/
│   └── ffmpeg/win/          # Windows FFmpeg（需手动下载，见安装说明）
├── electron-builder.yml     # 打包配置
└── package.json
```

---

## 插件开发

AutoSliceAI 支持三类插件：平台（Platform）、弹幕采集（Danmaku）、发布（Publisher）。

### 添加新平台（三步）

1. **实现平台插件** — `src/main/plugins/platform/<name>.ts`

```typescript
import type { PlatformPlugin } from './types'

export const plugin: PlatformPlugin = {
  metadata: {
    id: 'platform-mysite',
    name: 'My Site',
    icon: '🎮',
    supportedFeatures: ['live', 'danmaku'],
  },
  async getLiveStreamUrl(roomId: string): Promise<string> {
    // 返回直播流地址
  },
  async getRoomInfo(roomId: string) {
    // 返回房间信息
  },
}
```

2. **实现弹幕插件** — `src/main/plugins/danmaku/<name>.ts`（实现 `DanmakuCollector` 接口）

3. **注册到配置** — `plugins.config.json` 中添加 `{ "id": "platform-mysite", "enabled": true }`，`loader.ts` 中添加模块映射

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | Electron 33, electron-vite |
| 渲染层 | Vue 3, TypeScript, Element Plus, Pinia |
| 主进程 | TypeScript, Node.js |
| AI/ASR | Whisper (本地), OpenAI-compatible API |
| 音视频 | FFmpeg (静态链接), ffmpeg-static |
| 弹幕采集 | WebSocket (ws), aiohttp, Tars 协议解析 |
| 存储 | SQLite (better-sqlite3), YAML config |
| 自动发布 | Playwright (浏览器自动化) |
| 国际化 | vue-i18n (中文/English) |

---

## 注意事项

- **自动发布** 基于 Playwright 浏览器自动化，适合个人使用。需要先通过应用内登录各平台账号（Cookies 本地保存）。
- **本地 Whisper** 首次使用会自动下载模型文件（`base` 约 145MB），建议提前准备好网络环境。
- **虎牙弹幕** 使用 BrowserWindow 方式采集（让页面自身 JS 建立 WebSocket 连接），需要已登录虎牙账号。
- Windows 打包内置静态 FFmpeg（需手动放置 `static/ffmpeg/win/ffmpeg.exe`，见安装说明），macOS 使用 `ffmpeg-static`。

---

## 贡献指南

1. Fork 本仓库
2. 创建特性分支：`git checkout -b feature/your-feature`
3. 提交 Pull Request

---

## License

[Apache License 2.0](LICENSE)
