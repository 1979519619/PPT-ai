# PPT-AI Classroom · 课堂助手

Windows 上独立运行的课堂问答浮层。在 WPS 或 PowerPoint 放映旁，通过语音或圈选画面提出问题，回答显示在浮层面板中。

**当前源码：0.4.0-preview.1，未签名预览版。** 本轮按最终只读报告处理现存功能与构建问题，先提交源码，再构建 Windows x64 安装包。用户要求不运行修改后测试、不拆开安装包或重新安装验证；构建成功不等于已经完成其他设备兼容性验证。范围为 Windows 11 x64 单屏键鼠/触屏；**尚未在希沃一体机上测试**，不承诺投影和扩展双屏。历史公开 v0.3.0 安装器不代表本版。

## 内部待测入口

先退出旧版，再双击桌面“PPT-AI 课堂助手（最新版）”或根目录 `启动内部待测版.bat`。启动器不自动下载依赖，使用已准备的 `app/ocr-runtime/` 与本机语音模型；独立配置仍在 `work/internal-preview-profile/`，上一轮保存的本人 Key 保留。不要用 `E:\PPT-ai` 的旧 EXE 或既有 `app/dist` 安装器核验新功能。

历史操作与预期结果见 [手工核验流程](docs/INTERNAL_PREVIEW_TEST_GUIDE.md)。本轮修复与构建范围见 [最终修改记录](docs/FINAL_BUILD_CHANGES.md)。本地教程素材已保存在安装目录外的 `E:\PPT-ai-assets`，不放入软件运行资源。

## 功能与数据流

- 本机 Whisper small 将录音转成文字，确认后才向 DeepSeek 发送。
- 本地语音服务使用随机回环端口并核对所属进程；云端请求使用 Electron 网络栈跟随系统代理与证书设置。
- 圈选最多 5 个区域，每圈生成保留原像素的包围矩形裁图，预览确认后发送；浮球菜单新增中英翻译。
- 中英互译先以本地 RapidOCR 提取原文、行框和字高，可校正原文后批量翻译；只有选择图片翻译的区域才发送图片。无可靠文字位置时使用完整回答框或手动放置。
- 自动译注按原文可见字高匹配，用同一浏览器文字/公式渲染器测量；下方不能完整容纳时只回退相应段落。PowerPoint/WPS 原生数据只在窗口、页码、可见原文与 OCR 一致时增强字号。
- DeepSeek 流式回答，KaTeX 显示数学公式。
- 设置页保存 API Key，使用 Electron safeStorage / Windows DPAPI 加密；没有明文文件回退。
- 录音、屏幕截图和问答内容不由应用主动写入文件；本地日志记录状态、长度和错误码。操作系统及第三方服务的数据处理见 [隐私说明](PRIVACY.md)。

本项目调用 `https://api.deepseek.com`，需用户自己的 API Key、余额及可用的 `deepseek-flash` 模型权限。模型兼容性以实际连接测试为准。

## 从源码运行（Windows x64）

准备 Node.js 24 和 PowerShell。首次准备需要联网和约数 GiB 空间；Whisper 模型约 465 MiB。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/download-asr.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/prepare-ocr-runtime.ps1
cd app
npm ci
npx --no install-electron
npm test
npm start
```

Electron 二进制通过上面的显式安装命令准备。OCR 资源准备脚本默认将本地新增文件限定在 F 盘项目内，下载缓存和临时文件也在项目目录；CPU 推理使用嵌入式 Python，不依赖用户另装 Python 或 GPU。Koffi 使用锁定的 Windows x64 预编译依赖；在不支持的平台构建需另行核验。仓库不包含模型、运行时二进制或 node_modules。

开发入口为 `app/package.json`，唯一源码为 `app/m1/`。依赖准备好后也可双击根目录的 `启动桌宠.bat`。

## 使用

1. 按 `Ctrl+Alt+S` 打开普通设置窗口并保存自己的 API Key；“测试连接”只查模型列表，实际问答按手工流程核验。
2. 用 WPS 或 PowerPoint 打开 `docs/fixtures/acceptance-deck.pptx`，进入全屏放映。样张第 7/8 页保留早期“合并”文案，当前验收以每圈一图、最多 5 图为准，见 [验收范围](docs/ACCEPTANCE.md)。
3. `Ctrl+Alt+Space` 长按录音，松开后确认文字再发送；界面按钮点开始、再点停止，单次最长 30 秒。
   问题或翻译补充最多 300 字，按 Unicode 字符计数（空格、换行也计数）；超限保留文字并拒绝发送，录音结果同样需要删减后确认。
4. `Ctrl+Alt+X` 或点 AI 球圈选；`Ctrl+Z` 撤销，`C` 清空，`Enter` 完成，`Esc` 取消。
5. 右键/触屏长按浮球开菜单，拖动移动；`Ctrl+Alt+B` 显隐浮球，托盘可恢复；`Ctrl+Alt+H` 显隐面板，`Ctrl+Alt+C` 清除本次，`Ctrl+Alt+Q` 退出。
6. 仅 PPT/WPS 真正放映时自动找空白放回答；无空白或长答案可手选位置。中英互译先核对蓝色文字范围与原文，原文每区最多 12000 字、整批最多 40000 字，补充要求另计 300 字。自动译注优先与真实原文左边缘及宽度对应，在下方有限范围寻找空白，按可见字高约 85%–110% 选择字号；这是实现中的匹配区间，实际观感仍待核验。放不下、识别不可靠或画面变化的段落回完整回答框，其他段落继续显示。
7. 点击回答或译文的透明文本框进入编辑，可移动、四角拉伸，字号 8–128 像素，颜色仅黑、白、蓝。“完成调整”或 Esc 收起边框并保留文字；放映编辑中第一次点击框外只结束编辑，之后再点空白才正常推进动画/幻灯片。悬停不重新弹出边框。“返回回答框”保留完整结果，实际溢出也会回到回答框。普通窗口滚动/移动/切应用后清译文。面板里的 Esc 会停止当前操作并收起面板，保留输入和结果；明确清除请点“清除本次”或按 Ctrl+Alt+C。
8. 可靠页码可用时，翻页清空并取消旧请求，同页动画保留。无法取得可靠页码时用放映导航键、来源点击/滚轮等操作保守清除，同页动画也可能清除。原生文字增强跳过动画、分组、旋转和不支持的对象，表格/图片等使用 OCR。检测器停止仍清除旧结果；自动/外部翻页等边界需按本版清单核验。

截图通过 Electron desktopCapturer 获取，不安装 WPS 插件或修改 WPS 配置。首次正式使用前应确认课堂画面和题目可以发送给第三方服务。

## 构建和安装验证

```powershell
node scripts/sync-licenses.cjs
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/prepare-build.ps1
cd app
npm run dist -- --publish never
cd ..
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/checksums.ps1
```

本版安装器单独输出到 `app/dist/0.4.0-preview.1/`，避免与旧安装器混用。ASR 来自 `app/asr/`，OCR 来自 `app/ocr-runtime/`；排除安装工具、测试目录、缓存及未使用的默认识别模型。运行库、中文纯文本隐私页与必要外部脚本按配置加入安装流程。安装可选择目录，需要管理员确认；完成后不会自动启动，请双击桌面“PPT-AI 课堂助手”。本版卸载保留当前用户配置，不递归删除安装根目录中的任意个人文件；仍请将个人资料放在安装目录外。

公开 0.3.0 的构建结果不证明本版通过。本轮按用户要求只做修改和打包，不运行软件测试、不拆包、不安装复验；安装包生成后另附本版 SHA256。当前不进行 SignPath 提交或声称已经签名。

## Code signing policy

目前没有 SignPath 批准或签名；用户决定本阶段供 3–5 人内部使用，暂不签名。[签名政策与角色](CODE_SIGNING.md) 保留申请准备记录，不代表服务已获批。

## 许可与协作

本项目自有代码采用 [Apache License 2.0](LICENSE)。第三方组件和 Whisper 模型保留各自许可，见 [NOTICE](NOTICE)、`third_party/licenses/`。使用 [CONTRIBUTING.md](CONTRIBUTING.md)、[SECURITY.md](SECURITY.md) 和 [CHANGELOG.md](CHANGELOG.md) 了解协作、安全报告与变更。
