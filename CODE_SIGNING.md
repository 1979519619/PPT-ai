# Code signing policy

状态：申请准备中，尚未获 SignPath Foundation 批准，尚无签名证书或已签名构建。

## 责任角色

- 项目维护账号（待公开仓库确认）：GitHub `1979519619`。
- 代码作者、审阅者、发布及签名批准人：由仓库所有者确认；目前不宣称已有独立审阅团队。
- 外部贡献必须经维护者审阅；每次签名均由指定批准人手工批准。GitHub 与 SignPath 的多因素认证由账号所有者启用和核验。

## 构建和签名范围

只申请为本项目的可追溯构建签名，来源为公开仓库中的固定提交和构建工作流。保留提交 ID、工作流记录、安装器 SHA256、模型/运行时校验值。第三方 whisper.cpp、Electron、Koffi 等保留上游来源，不以本项目身份单独为上游二进制签名。打包包含上游组件不代表本项目拥有这些组件。

当前 `.github/workflows/build.yml` 只构建并上传未签名产物，不向 SignPath 发送请求，不发布 Release。获批后再加入经过审阅的 GitHub App、artifact configuration、签名策略和人工批准步骤；不把私钥或令牌提交到仓库。

获批并实际使用该服务后，主页和下载页才加入官方要求的署名：“Free code signing provided by SignPath.io, certificate by SignPath Foundation”，并链接相应官方页面。当前不将这句话作为已获服务的事实。

隐私政策见 [PRIVACY.md](PRIVACY.md)。服务条件见 [SignPath Foundation 条件](https://signpath.org/terms)。签名不保证绕过 SmartScreen，也不代表完成课堂或安装验收。
