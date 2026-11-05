# 中英互译架构与支持边界（0.4.0-preview.1）

日期：2026-11-05  
状态：P0—P3 代码已修改；未启动应用、未运行测试/语法检查/构建，运行与兼容性由用户核验。

## 1. 流水线

同一帧主屏截图 → 本机 OCR 原文/逐行位置 → 用户校正或选择图片后备 → 一次批量翻译 → 同字体真实排版测量 → 同列下方逐段放置 → 显示前重核来源与空白 → 溢出时完整回答框后备。

- 快照、选区 ID、epoch 与请求 ID 将识别、翻译、布局绑定到同一轮。
- 截图不是以绘圈掩膜涂白后的图片；OCR 在本机处理原分辨率矩形选区，映回全局逻辑坐标。
- 用户选框的余白不再直接决定原文字高或原文文字宽度。
- 普通问答路径保持原有录音、确认和教师场景；本轮重构集中在翻译。
- 每区可独立保留回答框，不再要求五区全部成功后才显示。
- 文本模式只在确认后发送原文与补充要求；勾选图片翻译的区域才发送相应选区图片，不为布局额外上传整屏。
- 用户问题/补充要求最多300字；识别原文每区12000字、合计40000字。两类限制分别处理。
- 本页临时内容保留在内存；翻页/清除使旧任务失效，不新增截图或原文历史数据库。

## 2. 模块职责

| 文件 | 职责 |
|---|---|
| app/m1/main.js | 快照、来源身份、原文确认、批量请求、逐段后备、显示前复核、迟到隔离 |
| app/m1/local-ocr.js | 有界可取消的本机识别子进程、内存图片传输、坐标映射 |
| app/m1/ocr-worker.py | RapidOCR/ONNX CPU 识别，显式本地模型，不自动联网下载 |
| app/m1/native-text.js、slide-text.ps1 | 可用时只读已有 PowerPoint/WPS 放映元数据；不启动或编辑 Office |
| app/m1/screen-layout.js | 整数裁图分析、障碍判断、字高校准、有限下方搜索与逐段失败说明 |
| app/m1/text-render.js | 共享字体、行距、换行与公式渲染规则，测量和最终显示使用同一基础 |
| app/m1/text-measure.html、text-measurer.js | 隔离的隐藏测量文档；等待字体后测实际布局尺寸，不运行云端请求 |
| app/m1/panel.html | 原文蓝框预览、校正/图片路径、方向、逐段结果和放置说明 |
| app/m1/overlay.html | 透明框、三色、8—128字号、移动拉伸、返回；真实溢出触发完整后备 |

隐藏测量窗口是程序正常运行时的内部排版部件；开发本轮没有创建或启动它。

## 3. P0：坐标与诊断

旧实现把逻辑矩形映射成整数裁图，再重建逻辑边界做零容差比较，存在边界往返误拒绝风险。新实现对精确裁图采用自身的整数像素坐标分析，不将“数学边界失配”解释成“下方有字”。

失败日志记录具体候选及几何信息，不记原文、译文或 Key。请求结果同时区分 overlay / partial / panel；REQUEST_DONE 只是请求完成，不能单独代表放置成功。

空白判断仍是保守像素启发式，并非完整场景语义理解。原文、其他已识别区域、已有译文及浮球作为显式障碍；图片/图表等还需要像素检查。低纹理背景并非所有情况下都能保证不含有意义图形，需真实材料核验。

## 4. P1：本机 OCR 与确认

- 资源：app/ocr-runtime/python、site-packages、models；开发版全部随当前源码入口读取。资源准备记录与模型校验见本轮交付记录/资源清单，准备不等于识别运行通过。
- 每次识别采用一个 CPU 子进程，内存输入/输出，有超时、取消和大小上限；截图/识别文本不写临时文件。
- 模型和字典使用显式本地路径；运行时禁止自动下载。
- 输出逐行文字、四点框映射后的矩形、置信度和字高估计。OCR 不提供准确字体名称和原始磅值。
- 低把握时允许校正。没有可靠几何信息时，校正文字也不能创造真实字高，应保留完整回答框/手选路径。
- 图片翻译适合 OCR 不可靠的复杂原文；它不具有可靠文字位置，因此不自动冒充“字号匹配成功”。

## 5. P2：真实排版与后备

1. 以 OCR 可见字高为基础；可靠原生字号只能作增强。
2. 对译文使用实际字体测量可见字高，校准目标字号，不固定从24一路试到8。
3. 目标范围为源可见字高约85%—110%；可编辑CSS字号为8—128。超出范围明确后备，不静默压小。
4. 等字体资源就绪，在与最终显示相同的字体、宽度、内边距、行距、换行及公式规则下测量。
5. 从原文下方开始，保持同列，在有限距离内搜索；不跳到远处或其他列。
6. 每段独立显示或后备，所有译文始终保留在完整回答框。
7. 显示前再截取来源，复核原文选区仍是同一画面、候选区域仍可用；有变化则拒绝旧位置。
8. 最终实际显示或手动改框后溢出，移除裁切浮层并保留完整内容，其他段落不受影响。

“全文完整、不遮原文”优先；相近字高其次；同宽/原文下方为优先布局。版面几何无解时正确后备也属于预期行为，不宣称所有页面都能原文下方显示。

## 6. P3：原生课件增强

- 只用 GetActiveObject 附加已经运行的应用，不调用 CreateObject、Open、Run、保存或编辑接口。
- 必须匹配现有放映 HWND、页面身份、来源窗口和主屏几何。按幻灯片点坐标 → 实际客户区物理像素与留黑 → 截图逻辑坐标换算。
- TextRange.BoundLeft/Top 已是相对幻灯片的位置，不能再次叠加 Shape.Left/Top；Font.Size 读取的磅值需要换算。
- 简单、可见、水平、未旋转文本/占位符/自选图形正文可尝试增强。
- 主动画或交互动画中出现的形状均保守排除；无法核实动画能力时整段原生增强不可用，回 OCR。
- 表格、分组、旋转、图片、SmartArt、嵌入演示等暂走 OCR，不将其标成原生支持已通过。
- 混合字体按原生 runs 检查，不能统一代表时不伪造一个精确字号。
- 只有原生文字与同帧 OCR 文字一致、几何合理时，主进程才采用字号信息；不替换 OCR 原文或其位置。
- WPS 对象能力逐项检查；其官方客户端 JSAPI 文档不能证明每台 Windows 的 COM 都具备相同成员。
- PowerPoint 成功不代表 WPS 通过；原生增强不可用时本机 OCR 与图片/手选后备仍可用。

## 7. 诊断代码速查

这些是程序内部日志代码，用户不需要改代码来验收。

| 代码/状态 | 含义与应有后备 |
|---|---|
| invalid-screen-bounds / invalid-candidate / candidate-outside-screen | 输入或候选坐标不合法；不解释成内容遮挡 |
| empty-pixel-crop / crop-size-mismatch / pixel-crop-failed | 精确裁图未完成；保留完整回答框 |
| capture-mismatch / capture-empty / capture-unavailable | 截图与当前范围不一致或不可用；重新圈选 |
| not-blank / occupied-by-region | 候选含纹理或与原文/其他区域冲突；有限同列下移，否则后备 |
| no-space-below | 下方不能完整容纳；完整回答框/手选 |
| source-unreliable / source-metrics-unavailable | 原文识别/字高不足；校正或手选，不能强行匹配 |
| source-font-out-of-range | 自动字号匹配超出8—128；完整回答框/手选 |
| measurement-unavailable / glyph-measurement-unavailable / measurement-missing | 真实排版或字高测量不可用；全文后备 |
| measured-overflow-or-font-mismatch | 实际尺寸或字高不满足约束；尝试允许范围，否则后备 |
| source-frame-changed | 显示前发现原文已变化；拒绝旧位置 |
| render-overflow | 最终显示/改框后不能完整显示；回完整回答框 |
| native-* | 原生附加、可见性、动画或几何能力不可靠；回 OCR，不能据此判云端翻译失败 |
| placement=overlay / partial / panel | 全部显示 / 部分显示 / 完整回答框，与请求完成分别记录 |

## 8. 验收与证据边界

手工流程见 INTERNAL_PREVIEW_TEST_GUIDE.md。识别、翻译、字高、位置、全文、翻页清除分别记录；无空间后备与坐标误拒绝分别归因。

本轮没有实机性能、兼容性、触屏、真实 API 或 OCR 准确率结果。资源文件校验不能代替推理运行；代码阅读不能代替真实排版观察。

实现参考为官方 API 能力和独立代码设计，没有将 GPL 应用代码直接搬入本项目。

## 官方参考

- PowerPoint TextRange.BoundLeft：https://learn.microsoft.com/en-us/office/vba/api/powerpoint.textrange.boundleft
- PowerPoint Font.Size：https://learn.microsoft.com/en-us/office/vba/api/powerpoint.font.size
- PowerPoint TextRange.Runs：https://learn.microsoft.com/en-us/office/vba/api/powerpoint.textrange.runs
- PowerPoint TimeLine.MainSequence：https://learn.microsoft.com/en-us/office/vba/api/powerpoint.timeline.mainsequence
- PowerPoint TimeLine.InteractiveSequences：https://learn.microsoft.com/en-us/office/vba/api/powerpoint.timeline.interactivesequences
- RapidOCR：https://github.com/RapidAI/RapidOCR
- 相关方案研究：outputs/PPT-ai_中英互译架构研究与修改计划_2026-11-05.md（上一轮只读研究，不是本轮实测结果）
