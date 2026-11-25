# 击杀点剪辑工作台

Windows 本地桌面应用。界面使用 Vben Admin v5 和 Ant Design Vue，桌面端用 Electron 调用 FFmpeg 与 FFprobe。需求见 [PRD.md](PRD.md)。

## 启动

在项目目录使用 Node.js 24 和 pnpm 11，运行以下命令。

```powershell
pnpm install --frozen-lockfile
pnpm build:antd
pnpm workbench
```

首次启动会下载 Electron 运行时。下载失败时可按网络环境配置 `ELECTRON_MIRROR`，再执行 `pnpm workbench`。FFmpeg 和 FFprobe 由项目依赖提供。也可通过 `KILL_CLIP_FFMPEG`、`KILL_CLIP_FFPROBE` 指定本机可执行文件。

## 剪辑流程

1. 新建或打开项目，批量添加录屏，也可拖放文件或扫描目录。
2. 选择视频，粘贴如 `1:29 1:45` 的击杀点，或用播放器标记当前位置。点击时间点可跳回素材。
3. 核对剪辑计划。默认前后各留 5 秒，窗口之间空隙不超过 8 秒时合并。上述两个点会保留 `01:24–01:50`。
4. 选择输出目录并导出。单卷默认最多 1 小时，超出后继续生成下一卷。输出为 720p 或 1080p 的 30 fps MP4，各卷通过解码和时长检查后发布到独立目录。
5. 在导出结果中播放抽查。`export-report.json` 记录各卷状态和源区间。可在导出的当前会话中发起清理，确认后将关联的素材移入系统回收站。

当前工作自动保存。可用「保存项目」写出独立的 `.killclip` 文件，以便保留多个项目。若素材已移动，可从预览区重新定位。播放器支持的编解码格式取决于 Electron，同一素材也可直接输入时间戳交给 FFmpeg。

## 验证与开发

```powershell
pnpm test:workbench
pnpm -F @vben/web-antd typecheck
pnpm -F @vben/web-antd exec vite --host 127.0.0.1 --port 5666 --strictPort
```

浏览器访问 `http://127.0.0.1:5666/workbench` 可预览页面。要连上桌面功能，在另一个 PowerShell 中设置 `$env:KILL_CLIP_DEV_URL = 'http://127.0.0.1:5666/'` 并运行 `pnpm workbench`。
