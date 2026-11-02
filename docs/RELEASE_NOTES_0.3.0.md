# PPT-AI Classroom v0.3.0 — 未签名测试版

Windows x64 课堂问答浮层：本机 Whisper small 语音识别、识别文字确认、最多 5 区圈选、DeepSeek 流式回答和 KaTeX 公式显示。需要使用者自己的 DeepSeek API Key；云端请求可能产生 API 费用。

**这是公开预发布版本（Pre-release），安装器尚未签名，完整课堂验收尚未完成。** 请先在自用或试讲环境验证，不将其视为已经验收的正式课堂版本。Windows 或第三方安全软件可能提示未识别的发布者。

## 下载与核验

- `PPT-AI-Setup-0.3.0.exe`：Windows x64 安装器，包含本地语音模型。
- `SHA256SUMS`：安装器 SHA256 校验值，下载后应核对。
- 安装需要管理员确认，可以选择安装目录。卸载入口由安装器提供。
- 按 `Ctrl+Alt+S` 打开设置并保存自己的 API Key；`Ctrl+Alt+Q` 正常退出。

## 构建来源与验证范围

- 源码提交：[ae8a4be](https://github.com/1979519619/PPT-ai/commit/ae8a4be2fd1cf45eb1cd518a618b0c1c5ad099fa)。
- [GitHub Actions 构建记录](https://github.com/1979519619/PPT-ai/actions/runs/41477193774)：ASR 下载校验、锁定依赖安装、9 项回归检查、未签名安装器构建及校验文件生成均通过。
- 本页附件来自该 CI 构建，上传前验证了 artifact 归档摘要及安装器 SHA256。
- 本地同源码构建已进行安装、启动、加密保存和卸载验证。本页的 CI 安装器尚未单独重复安装验收。
- WPS 完整验收、PowerPoint 冒烟、教室机/触屏、多显示器、30 分钟长稳和真实课堂验证仍待完成；参见[验收范围](https://github.com/1979519619/PPT-ai/blob/v0.3.0/docs/ACCEPTANCE.md)。

## 隐私与许可

音频在本机识别。发送操作会将确认后的文字及选定的圈选图发往 DeepSeek。应用不主动保存录音、整屏截图、圈选图或问答正文；操作系统缓存及第三方服务处理方式见[隐私说明](https://github.com/1979519619/PPT-ai/blob/v0.3.0/PRIVACY.md)。

项目自有代码采用 [Apache-2.0](https://github.com/1979519619/PPT-ai/blob/v0.3.0/LICENSE)，第三方组件和模型保留各自许可；安装包包含相应声明。

## Code signing policy

计划申请 SignPath Foundation 免费开源签名服务；**截至本次发布，申请尚未提交、尚未获批，当前安装器未获 SignPath 签名**。这里不宣称 SignPath 已为项目提供签名。

签名范围、批准流程、角色待确认事项与隐私政策见[Code signing policy](https://github.com/1979519619/PPT-ai/blob/v0.3.0/CODE_SIGNING.md)。发布此预览版不代表满足 SignPath 的全部资格条件或保证获批。
