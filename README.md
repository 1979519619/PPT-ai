# PPT-AI Classroom · 课堂助手

Windows 上独立运行的课堂问答浮层。在 WPS 或 PowerPoint 放映旁，通过语音或圈选画面提出问题，回答显示在浮层面板中。

**状态：0.3.0 开源准备版，未签名。** 新工作区的完整课堂验收尚未完成。触屏、多显示器及教室设备兼容性尚未验证。不要将未经验证的构建直接用于正式课堂。

## 功能与数据流

- 本机 Whisper small 将录音转成文字，确认后才向 DeepSeek 发送。
- 圈选最多 5 个区域，每圈生成一张遮罩裁切图；补充文字后发送。
- DeepSeek 流式回答，KaTeX 显示数学公式。
- 设置页保存 API Key，使用 Electron safeStorage / Windows DPAPI 加密；没有明文文件回退。
- 录音、屏幕截图和问答内容不由应用主动写入文件；本地日志记录状态、长度和错误码。操作系统及第三方服务的数据处理见 [隐私说明](PRIVACY.md)。

本项目调用 `https://api.deepseek.com`，需用户自己的 API Key、余额及可用的 `deepseek-flash` 模型权限。模型兼容性以实际连接测试为准。

## 从源码运行（Windows x64）

准备 Node.js 24 和 PowerShell。首次准备需要联网和约数 GiB 空间；Whisper 模型约 465 MiB。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/download-asr.ps1
cd app
npm ci
npx --no install-electron
npm test
npm start
```

Electron 二进制通过上面的显式安装命令准备。Koffi 使用锁定的 Windows x64 预编译依赖；在不支持的平台构建需另行核验。离线环境可使用本地校验通过的 ASR 资源，见下载脚本参数。仓库不包含模型、运行时二进制或 node_modules。

开发入口为 `app/package.json`，唯一源码为 `app/m1/`。依赖准备好后也可双击根目录的 `启动桌宠.bat`。

## 使用

1. 启动应用，按 `Ctrl+Alt+S` 打开设置并保存自己的 API Key；按“测试连接”核验。
2. 用 WPS 或 PowerPoint 打开 `docs/fixtures/acceptance-deck.pptx`，进入全屏放映。样张第 7/8 页保留早期“合并”文案，当前验收以每圈一图、最多 5 图为准，见 [验收范围](docs/ACCEPTANCE.md)。
3. `Ctrl+Alt+Space` 长按录音，松开后检查识别文字，再发送。
4. `Ctrl+Alt+X` 或点 AI 球圈选；`Ctrl+Z` 撤销，`C` 清空，`Enter` 完成，`Esc` 取消。
5. `Ctrl+Alt+H` 显隐面板，`Ctrl+Alt+Q` 退出。

截图通过 Electron desktopCapturer 获取，不安装 WPS 插件或修改 WPS 配置。首次正式使用前应确认课堂画面和题目可以发送给第三方服务。

## 构建和安装验证

```powershell
cd app
npm run dist
```

安装器在 `app/dist/`，ASR 来自 `app/asr/`。安装可选择目录；本地验证目标为 `E:\PPT-ai`。安装器为所有用户安装，需要管理员确认。卸载程序位于安装目录，也可通过 Windows“已安装的应用”卸载。卸载会移除本用户的 `ppt-ai` 应用数据，请先备份需要保留的配置。

GitHub Actions 工作流只生成未签名安装器、SHA256SUMS 和第三方许可证记录，不自动推送或发布 Release。CI 尚需在公开仓库运行验证。下载发布文件后应核对校验值；签名与 SmartScreen 信誉并非同一概念。

## Code signing policy

目前没有 SignPath 批准或签名，所有当前构建均按未签名处理。计划申请 SignPath Foundation；[签名政策与角色](CODE_SIGNING.md) 说明申请和手工批准流程。获批前不使用已提供签名服务的宣传语。

## 许可与协作

本项目自有代码采用 [Apache License 2.0](LICENSE)。第三方组件和 Whisper 模型保留各自许可，见 [NOTICE](NOTICE)、`third_party/licenses/`。使用 [CONTRIBUTING.md](CONTRIBUTING.md)、[SECURITY.md](SECURITY.md) 和 [CHANGELOG.md](CHANGELOG.md) 了解协作、安全报告与变更。
