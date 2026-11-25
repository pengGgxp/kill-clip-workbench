# Kill Clip Workbench

Windows 优先的本地 FPS 游戏录屏剪辑工作台。它不依赖枪声识别模型：你只需要标记击杀发生的时间点，工作台就会自动生成片段、合并相近片段、按时长分卷并渲染成 MP4。

它适用于 **CS2、Valorant、Apex Legends、PUBG、Call of Duty、Overwatch、Rainbow Six Siege、The Finals** 以及其他 FPS 游戏的录屏，不局限于 CS。

## 主要能力

- 批量导入录屏，支持拖放文件和扫描目录。
- 为每条录屏输入多个时间点，例如 `1:29 1:45`，也可以在播放器当前位置直接标记。
- 每个时间点默认截取前后各 5 秒，前后保留时长可在项目设置中调整。
- 自动合并间隔不超过指定值的相邻片段，默认合并间隔为 8 秒。
- 按单卷最长时长导出，默认每卷不超过 1 小时，可改为其他小时数。
- 输出分辨率可跟随源素材原始尺寸，也可以选择 720p 或 1080p；例如 1440×1080 的录屏可以保持源分辨率输出。
- 导出时显示扫描、渲染和分卷进度，并生成 `export-report.json`。
- 可选 MVUtensils FlowBlur 运动模糊，使用运动矢量处理画面，不依赖准星、HUD 或文字识别。
- 工作台自动保存当前项目，也支持保存和打开独立的 `.killclip` 项目文件。
- 只有在导出成功并由用户确认后，才会把已处理的源素材移入系统回收站。

## 工作流程

1. 新建项目并批量添加录屏。
2. 选择一条录屏，输入击杀时间点或用播放器逐个标记。
3. 在剪辑计划中检查片段窗口、自动合并结果和预计分卷。
4. 选择输出目录、单卷最长时长、分辨率和可选运动模糊。
5. 开始导出，逐卷播放抽查。
6. 确认成片无误后，再选择是否清理源素材。

时间点支持以下格式：

```text
1:29 1:45
00:01:29
00:01:29.500
```

例如前后各保留 5 秒时，`1:29` 会生成 `1:24–1:34`。如果另一个时间点生成的窗口与它之间间隔不超过 8 秒，两个窗口会自动合并。

## Windows 安装版

安装包是 Windows x64 版本，内置 Electron、FFmpeg、FFprobe 以及 FlowBlur 运行环境，不需要另外安装 Node.js 或 Python。当前安装包未签名，Windows 可能显示“发布者未知”。

安装包由以下命令生成：

```powershell
pnpm package:win
```

生成文件位于 `release/`，该目录默认不提交到 Git。程序更新后需要重新生成并安装新的版本；开发版可以直接运行启动脚本，不需要安装包。

## 从源码启动

要求：

- Windows x64
- Node.js `22.18+` 或 `24.12+`
- pnpm `11+`

安装依赖并准备运动模糊运行环境：

```powershell
pnpm install --frozen-lockfile
pnpm setup:flowblur
pnpm build:antd
```

启动开发版：

```powershell
.\start-workbench-dev.ps1
```

脚本会复用或启动 `http://127.0.0.1:5666/` 的 Vite 服务，再打开 Electron 开发版。也可以手动运行：

```powershell
pnpm workbench
```

浏览器预览地址：

```text
http://127.0.0.1:5666/workbench
```

如果 PowerShell 禁止执行本地脚本：

```powershell
powershell -ExecutionPolicy Bypass -File .\start-workbench-dev.ps1
```

`pnpm setup:flowblur` 会准备 Windows x64 的 Python、VapourSynth 和 MVUtensils。运动模糊默认关闭；不使用运动模糊时可以跳过该步骤。首次启动 Electron 可能需要下载运行时。

## 常用命令

```powershell
pnpm test:workbench
pnpm -F @vben/web-antd typecheck
pnpm build:antd
pnpm package:win
```

## 项目结构

- `apps/web-antd/`：Vben Admin v5 + Ant Design Vue 工作台界面。
- `apps/desktop/`：Electron 主进程、项目文件、剪辑计划、FFmpeg/FFprobe 和 FlowBlur 渲染流程。
- `apps/desktop/src/clip-plan.mjs`：时间点、片段窗口、自动合并和分卷计划。
- `apps/desktop/src/media.mjs`：媒体探测、渲染、输出校验和清理。
- `apps/desktop/src/flowblur.py`：调用 VapourSynth/MVUtensils FlowBlur 的帧处理脚本。
- `PRD.md`：产品需求与行为约定。
- `WORKBENCH.md`：Windows 安装、启动和操作说明。

## 设计边界

- 这是本地剪辑工具，不会自动上传抖音或其他平台。
- 当前剪辑依据是用户标记的时间点，不会自动判断“这个时间点是否真的击杀”。
- 项目优先支持 Windows x64；Linux 和 macOS 目前没有经过打包验证。
- 视频是否能在播放器中预览取决于 Electron 支持的编解码格式，但导出流程使用 FFmpeg。
- 源素材不会自动删除，清理操作需要用户明确确认，并优先移入回收站。

## 致谢与许可

界面基于 [Vben Admin](https://github.com/vbenjs/vue-vben-admin) 和 Ant Design Vue，桌面端使用 Electron，媒体处理使用 FFmpeg/FFprobe，运动模糊使用 VapourSynth 与 MVUtensils FlowBlur。

本项目使用 [MIT License](./LICENSE)。

中文文档就是本文件；项目代码和提交信息以仓库内容为准。
