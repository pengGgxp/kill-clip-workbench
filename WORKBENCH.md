# 击杀点剪辑工作台

Windows 本地桌面应用。界面使用 Vben Admin v5 和 Ant Design Vue，桌面端用 Electron 调用 FFmpeg 与 FFprobe。需求见 [PRD.md](PRD.md)。

## 安装与启动

双击 `release/Kill-Clip-Workbench-Setup-1.1.1-x64.exe` 安装 Windows x64 版，再从开始菜单打开 **Kill Clip Workbench**。安装包内置 Electron、FFmpeg、FFprobe 和运动模糊运行环境，无需另装 Node.js 或 Python。当前安装包未签名，Windows 可能提示发布者未知。

## 从源码启动

在项目目录使用 Node.js 24 和 pnpm 11，运行以下命令。

```powershell
pnpm install --frozen-lockfile
pnpm setup:flowblur
pnpm build:antd
pnpm workbench
```

以后也可以直接运行仓库根目录的 `start-workbench-dev.ps1`：

```powershell
.\start-workbench-dev.ps1
```

脚本会自动复用或启动 `127.0.0.1:5666` 的 Vite 服务，再打开 Electron 开发版。若 PowerShell 禁止执行本地脚本，可使用：

```powershell
powershell -ExecutionPolicy Bypass -File .\start-workbench-dev.ps1
```

首次启动会下载 Electron 运行时。下载失败时可按网络环境配置 `ELECTRON_MIRROR`，再执行 `pnpm workbench`。FFmpeg 和 FFprobe 由项目依赖提供。也可通过 `KILL_CLIP_FFMPEG`、`KILL_CLIP_FFPROBE` 指定本机可执行文件。

`pnpm setup:flowblur` 为开发版准备 Windows x64 的 Python、VapourSynth 和 MVUtensils。Windows 打包时会自动准备并内置这些依赖。

在 Windows x64 上运行 `pnpm package:win` 可重新生成安装包。程序版本号在 `apps/desktop/package.json`，生成文件在 `release/`，不纳入 Git。

## 剪辑流程

1. 新建或打开项目，批量添加录屏，也可拖放文件或扫描目录；扫描时显示已处理数量和当前文件。
2. 选择视频，粘贴如 `1:29 1:45` 的击杀点，或用播放器标记当前位置。点击时间点可跳回素材。
3. 核对剪辑计划。默认前后各留 5 秒，窗口之间空隙不超过 8 秒时合并。上述两个点会保留 `01:24–01:50`。
4. 选择输出目录并导出。单卷默认最多 1 小时，超出后继续生成下一卷。默认跟随每卷首段素材的原始分辨率，也可指定 720p 或 1080p；输出为 30 fps MP4，显示总体和分卷进度。各卷通过解码和时长检查后发布到独立目录。不同宽高比的视频会按比例适配该卷尺寸，不会裁切。
5. 在导出结果中播放抽查。`export-report.json` 记录各卷状态和源区间。可在导出的当前会话中发起清理，确认后将关联的素材移入系统回收站。

当前工作自动保存。可用「保存项目」写出独立的 `.killclip` 文件，以便保留多个项目。若素材已移动，可从预览区重新定位。播放器支持的编解码格式取决于 Electron，同一素材也可直接输入时间戳交给 FFmpeg。

在「剪辑设置」勾选「运动模糊」，导出时会用 MVUtensils FlowBlur 的 50% 强度对每个片段分别处理。默认关闭，原素材预览仍播放源文件。

## 验证与开发

```powershell
pnpm test:workbench
pnpm -F @vben/web-antd typecheck
pnpm -F @vben/web-antd exec vite --host 127.0.0.1 --port 5666 --strictPort
```

浏览器访问 `http://127.0.0.1:5666/workbench` 可预览页面。要连上桌面功能，在另一个 PowerShell 中设置 `$env:KILL_CLIP_DEV_URL = 'http://127.0.0.1:5666/'` 并运行 `pnpm workbench`。
