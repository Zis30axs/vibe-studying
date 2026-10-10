# ExamCraft

一款 **Electron + React + TypeScript** 学科 IDE。覆盖语文、数学、英语、政治、历史、地理六科，把选择题、文字解答、文科嵌套论证模块、数学交互工具和地理坐标图放进同一个本地学习空间。

首个 MVP 的完整闭环：**选题 → 作答 / 自动保存草稿 → 提交 → 规则反馈与解析 → 查看历史 → 重做**。无需账号或 API Key，安装完成后可离线练习。仓库原有 GPL-3.0 许可证保留。

![ExamCraft 桌面练习界面](docs/screenshots/practice.png)

## Windows 便携版

在 [GitHub Releases](https://github.com/Zis30axs/vibe-studying/releases) 下载对应版本的 `ExamCraft-<版本>-win-x64.zip`，完整解压后打开 `ExamCraft.exe`。便携包包括 Electron 运行时，无需安装 Node.js；不要只移动 EXE，须保留旁边所有文件。

这是未签名的 Windows x64 便携应用。Windows 可能提示未知发布者；只运行你确认可信的下载，并可用同版 `SHA256SUMS.txt` 校验文件。默认学习数据仍在 `%APPDATA%\ExamCraft`，升级前先退出应用并备份。应用内部版本为 0.2.0；此手工便携包保留 Electron 的默认 EXE 图标与 Windows 文件属性，不代表应用内版本。没有自动更新器。

开发者可在 Windows x64 干净提交检出中运行：

```sh
npm ci
npm run check
npm run test:e2e
npm run package:win
npm run test:packaged
```

产物位于 `work/release/`：可运行 Windows ZIP、对应源码 ZIP、SHA-256 校验文件。GitHub 发布流程只在 Linux/Windows 检查、全部桌面用例及解压后可执行文件烟雾测试通过后发布，且不覆盖已有版本。详见 [0.2.0 发布说明](docs/releases/v0.2.0.md)。

## 本地运行

需要 Node.js **22.12+（推荐 24 LTS）**、npm，以及支持 Electron 的桌面系统。首次安装/启动需要联网下载 npm 依赖与 Electron 二进制。

```sh
git clone https://github.com/Zis30axs/vibe-studying.git
cd vibe-studying
git switch main
npm ci
npm run dev
```

开发模式同时启动 Vite 和 Electron；React 页面支持热更新，修改 `electron/` 或 `mcp/` 后需重启。`npm run dev:web` 仅供调试页面服务，完整功能需要 Electron 的本地 API。

构建并启动生产页面：

```sh
npm run build
npm start
```

`build` 生成 `dist/`、`dist-electron/`、`dist-mcp/`，本身不是安装包；Windows 可用上方 `package:win` 组装便携版。`start` 需要先构建。若首次 Electron 下载失败，可在网络恢复后运行 `npx --no install-electron`。

## 试用顺序

1. **题目练习**：选择“从实践中发现问题”，选一个选项、写下理由、提交。选择题按标准答案判分；解析只在提交后的界面展示。
2. **练习记录**：查看本次答案、时间、得分和解析；重新练习会新增记录，保留先前提交。
3. **文科组装**：在语文、政治、历史、地理主观题中，把空白观点、材料、分析、结论模块拖到插槽；用因果、对比、分点容器嵌套。填写内容后，点“用模块更新正文”，检查并自由修改最终正文，再提交自查。
4. **地理工作台**：切换经纬度，添加 A(20,30)、B(40,50)，连线并解释方向。支持精确坐标输入、鼠标描点、编辑、删除、撤销；换坐标系需要确认清空。
5. **数学工作台**：在数学题旁绘制函数、调节 a/b/c 参数、拖动几何点并测量距离与角度；写下推理后提交。
6. 关闭再打开应用，草稿和提交历史仍保留。右上角可导入 `examples/question-bank.json`，然后搜索“导入示例”。

内置 18 道题均为**原创演示题，非历年真题**。主观题的“分数”只是关键词规则自查结果，不判断否定、语义、论证顺序或图形是否正确，不能当作考试评分。绘图和模块编辑均保存在提交快照中。

## 六科练习

在「题目练习」按学科筛选；每科有 3 道原创演示题，共 18 道。

- 语文：修辞选择、现代文阅读、建议表达。
- 数学：函数选择、方程步骤、概率解释；文字作答旁提供函数曲线、参数滑块、可拖动几何点和距离/角度测量。
- 英语：阅读选择、证据分析、邀请邮件；显示参考词数。
- 政治：选择题与嵌套模块论证。
- 历史：史料选择、材料分析、因果解释；模拟史料明确标记为原创情境。
- 地理：原有选择题与坐标绘图。

新科目同样支持自动保存、逐项自查、历史快照和重做。原 version-1 题库与学习记录无需迁移，原题 ID 不变。升级时，已导入题目优先保留；若新示例与旧导入 ID 冲突或总量会超过 1000 道，则不加载相应的新示例，不覆盖旧题与历史。六科可通过相同 JSON 格式导入、按 MCP 学科范围查询和审阅；新增示例见 `src/domain/extra-sample-questions.ts`。

本地文字审阅只是关键词覆盖提示：不验证数学公式、英语语法、语文立意或历史因果。英语按词语边界匹配，仍可能漏掉同义表达或误判否定句。DeepSeek 请求包含各学科的评阅关注点，但仍须逐次同意发送，模拟测试不能证明真实模型的评分质量。

## 学习提交热力图

页面上方显示最近 26 周的本地日历：一天一格，颜色随当天已保存的提交次数逐级加深（0、1、2–3、4–6、7 次及以上）。点击或用键盘聚焦日期，可以查看当天记录并打开对应的审阅历史。

热力图直接从已有提交历史计算：重做后再次提交会累计；自动保存草稿、校验失败和没有生成已保存记录的 API 失败不会增加次数。当天日期按运行应用的电脑本地时区计算，跨午夜会自动更新；无效时间戳、未来提交时间和显示范围之外的记录不计入当前图。切换电脑时区后，历史记录所属日期会按该时区重新显示。无提交的日期保持中性色，不评价连续学习天数。

## 文科模块工作台

- **自由组装**：四科提供各自的提示与空白结构模板，不预填参考答案。观点、材料、分析、结论是内容块；因果、对比、分点是容器，可继续嵌套。模块颜色、缺口和高亮插槽显示连接位置。
- **拖动或点选**：从模块库拖入插槽，拖动已有块可排序或移动到容器中。也可点选模块，再点击目标插槽；支持键盘聚焦和 Enter / Space，触屏使用相同点选方式。删除后可撤销。
- **最终正文由你控制**：模块生成预览不会自动覆盖正文。“用模块更新正文”才会同步；正文已有不同内容时需确认覆盖，可取消。修改模块后仍可保留手写正文；提交与关键词自查以当前最终正文为准，新模块草稿需要先填写或同步正文（地理仍可仅提交绘图）。
- **本地保存与历史**：每次改动自动保存；历史保留提交时的嵌套结构和最终正文。已有 version-1 草稿、扁平模块、题库导入和历史继续可读。旧模块在工作台中映射为叶节点；新结构写入可选 argument 字段，旧字段保留。新版本写出的 argument 字段不保证被旧版程序读取，请先备份数据。
- **有界结构**：最多 80 个模块、6 层，每块最多 4,000 字，生成正文最多 20,000 字；拒绝循环、共享节点、重复 ID 和超限结构。超限的旧内容不会被自动截断，需先保留备份并缩减内容后转换。
- **审阅边界**：本地自查不理解嵌套逻辑、不验证因果或论点正确性。DeepSeek 仅在逐次确认后接收当前题目、当前正文、嵌套结构、绘图及本次学习范围；修改任何答案内容后须重新确认。此功能未使用真实 API 凭据验证评分质量。

## 数学交互工具

数学题旁的工作台提供：

- **函数曲线**：输入单个 `y = f(x)` 的右侧表达式，例如 `a*x^2+b*x+c` 或 `a*sin(b*x)+c`；a/b/c 的滑块实时更新曲线。
- **几何交互**：在直角坐标系描点、精确编辑坐标、拖动点和连接两点。坐标范围为 x、y 各 `[-10, 10]`。
- **测量**：依次选择两个点计算欧氏距离，选择三个点计算以第二点为顶点的角度（度数）；重合的边端点无法定义角度。
- **保存与回看**：函数、参数、点线和测量选点随当前题目自动保存，也写入每次提交的独立快照。原有 version-1 无数学字段的草稿与历史仍可读取。

表达式使用有界的专用解析器，不执行 JavaScript，也不使用 `eval` / `Function`：

- 变量 `x`，参数 `a`、`b`、`c`（各为 `[-10, 10]` 有限数），常量 `pi`、`e`。
- 运算 `+ - * / ^`、括号、正负号；支持小数与科学计数法。幂从右向左结合，`-2^2` 为 `-4`。
- 函数 `sin`、`cos`、`tan`（弧度）、`sqrt`、`abs`、`exp`、`log`（自然对数）。函数必须加括号，乘法必须显式写 `*`；不接受 `2x`、`Math.sin(x)`、赋值、属性访问或脚本。
- 最多 160 字符、120 个词法符号、32 层嵌套。可清空表达式以只使用几何工具。

曲线是固定视窗 `[-10, 10] × [-10, 10]` 内的数值采样预览；遇到无定义、非有限值、越界或疑似不连续区间时断开。它不是符号计算系统，不能保证发现全部间断点、极值或快速振荡，也不自动解方程或证明几何命题。测量是基于当前浮点坐标的近似数值。本地评分仍只检查文字关键词，主观数学题必须填写推理文字；图形本身不作为正确性的判定。工具不新增题目，也不会自行调用云端。

数学函数输入可留空或点击「清除函数」，只保留几何图形。参数数值输入超出范围或不完整时不会保存，离开输入框会恢复最后有效值。

## 数据与题库

数据保存在 Electron 的 `app.getPath('userData')` 下：

- Windows：通常为 `%APPDATA%/ExamCraft/`
- macOS：通常为 `~/Library/Application Support/ExamCraft/`
- Linux：通常为 `~/.config/ExamCraft/`
- `study-state.json`：草稿与全部提交快照。
- `question-bank.json`：导入的题目；不包含内置题。

写入经队列串行化，先写临时文件并同步，再原子替换；关窗等待在途草稿/提交落盘。损坏或不兼容文件会报错并保留原文件，不会静默重置。备份时先退出应用，再复制整个数据目录；当前没有自动备份或数据迁移工具。每个 JSON 文件上限 8 MiB，总题目数上限 1000（包括内置 18 道）；达到限制时拒绝新写入并保留原数据。

导入是**追加**：重复 ID 会拒绝整批导入，不覆盖题目或历史。只读取用户通过本地文件选择器选中的 JSON 文件。格式如下；完整可导入文件见 [examples/question-bank.json](examples/question-bank.json)，字段校验见 [schemas.ts](src/domain/schemas.ts)。

```json
{
  "version": 1,
  "questions": [
    {
      "id": "my-geo-1",
      "subject": "geography",
      "kind": "choice",
      "title": "纬度的起点",
      "prompt": "纬度 0° 对应哪条线？",
      "source": "个人原创示例",
      "tags": ["经纬网"],
      "maxScore": 4,
      "choices": [
        { "id": "A", "text": "赤道" },
        { "id": "B", "text": "本初子午线" }
      ],
      "correctAnswer": "A",
      "explanation": "赤道是纬度 0° 的纬线。"
    }
  ]
}
```

`subject` 为 `chinese` / `math` / `english` / `politics` / `history` / `geography`；`kind` 为 `choice` 或与学科相同的值。所有学科支持选择题；语文、政治、历史、地理主观题可使用嵌套模块辅助作答；数学、英语使用文字作答，数学可附带交互工具状态，地理同时保留绘图。主观题必须提供 `rubric`（`id`、`label`、`keywords`、`points`），分值之和等于 `maxScore`；政治题可提供 `blocks`（`id`、`category`、`label`、`text`）。模板见 [sample-bank.ts](src/domain/sample-bank.ts)。仅导入你有权使用的题目，来源字段用于追溯。

## 本地 MCP 与 Agent 扩展

这是实际使用官方 SDK 的 **stdio MCP 服务**，与桌面应用共享题库校验和规则审阅。桌面 MVP 直接调用本地适配层；外部 MCP 客户端可以独立启动服务。

```sh
npm run build
node dist-mcp/server.cjs --subject geography --tag 经纬网
```

该命令会等待 MCP 客户端输入，并非交互式命令行。配置客户端时直接启动 `node`，避免 npm 日志混入协议 stdout：

```json
{
  "mcpServers": {
    "examcraft": {
      "command": "node",
      "args": [
        "C:/absolute/path/vibe-studying/dist-mcp/server.cjs",
        "--subject",
        "geography",
        "--tag",
        "经纬网"
      ]
    }
  }
}
```

将路径改为自己的绝对路径。可用选项：

| 参数                              | 作用                                                 |
| --------------------------------- | ---------------------------------------------------- |
| `--subject chinese` 等六科学科 ID | 限定学科                                             |
| `--tag 经纬网`                    | 限定标签；可重复，多个标签取交集                     |
| `--question-id geo-choice-1`      | 限定题号；可重复，多个 ID 取并集，再与其他条件取交集 |
| `--bank /absolute/path/bank.json` | 使用指定题库快照，替代内置题库；路径必须绝对         |

服务器范围在启动时固定，工具请求只能进一步缩小范围。`list_questions`、`get_question`、`review_answer` 都执行范围检查。未指定 `--bank` 时仅服务内置示例；指定桌面的 `question-bank.json` 时仅服务已导入的题目。MCP 进程只读题库，审阅不会写桌面历史；调整题库后需重启 MCP 服务。

| 工具             | 输入                                  | 输出                                         |
| ---------------- | ------------------------------------- | -------------------------------------------- |
| `list_questions` | 可选 `subject`、`tags`、`questionIds` | 允许范围内的完整题目                         |
| `get_question`   | `questionId`                          | 单题（含答案与 rubric，供受信任 Agent 使用） |
| `review_answer`  | `questionId`、`draft`                 | 规则反馈，不保存历史                         |

最小 `draft`：

```json
{
  "choiceId": "C",
  "text": "",
  "blocks": [],
  "drawing": { "mode": "cartesian", "points": [], "lines": [] }
}
```

数学作答可以在 `draft` 中附带可选 `math` 字段；旧客户端不传该字段仍有效。示例：

```json
{
  "expression": "a*x^2+b*x+c",
  "parameters": { "a": 1, "b": 0, "c": 0 },
  "drawing": {
    "mode": "cartesian",
    "points": [
      { "id": "A", "x": 0, "y": 0, "label": "A" },
      { "id": "B", "x": 3, "y": 4, "label": "B" }
    ],
    "lines": [{ "id": "AB", "from": "A", "to": "B" }]
  },
  "measurement": ["A", "B"]
}
```

`measurement` 按选择顺序保存最多 3 个不同的现有点 ID；数学图形只允许直角坐标系。MCP 的 `review_answer` 会校验该状态，但仍只返回本地规则审阅，不操作桌面工作台、生成图形或发送 DeepSeek 请求。

适配器接口位于 [contracts.ts](src/adapters/contracts.ts)：

- `QuestionBankAdapter`：`list(scope)` / `get(id, scope)`。
- `AgentAdapter`：`review(question, draft)`。
- `LocalQuestionBank` / `LocalRuleAgent`：当前默认实现。
- `McpQuestionBankAdapter` / `McpAgentAdapter`：接受宿主已连接的可信 MCP `Client`，校验工具返回值。不会接受题库中提供的命令或自动启动未知程序。

后续接入模型时，在主进程中替换 `StudyService` 的 Agent；密钥与网络调用留在主进程，保留反馈结构校验。桌面现可选择 DeepSeek 云端评阅；仍没有 AI 出题或 GUI 密钥管理。

## DeepSeek 评阅（可选）

默认仍为离线本地规则。DeepSeek 模式接入官方 `https://api.deepseek.com/chat/completions`，默认模型 `deepseek-flash`，通过 JSON Output 返回可校验的评分项。模型评语可能出错，只用于学习反馈，不是官方考试阅卷。

凭据由用户在启动应用前自行安全配置到进程环境变量 `DEEPSEEK_API_KEY`。不要粘贴到聊天、答案、考纲、源码、命令历史或仓库文件；本项目不读取 `.env`，没有密钥输入框或持久化密钥功能。可选非秘密变量 `EXAMCRAFT_DEEPSEEK_MODEL` 选择官方支持的模型。主进程读取密钥后清除对应环境变量，避免再继承给渲染器；密钥不经过 IPC、不进入日志或学习记录。

操作流程：

1. 选原创示例或导入有权使用的 JSON 题库，完成作答。
2. 选择「DeepSeek 云端」，可填写本次学习范围/考纲节选。未提供考纲时只按题目和 rubric 评阅，不声称符合某地区官方考纲。
3. 移除题目、答案、范围中的身份和私人信息。逐次勾选发送同意，当前题目（来源、参考答案、rubric）、本次最终正文、模块文字与嵌套论证结构、结构化坐标及学习范围（数学题还包含函数表达式、a/b/c 参数、几何点线与测量选点）将发送至 DeepSeek。不会附带历史练习、以往成绩或账户身份。API 调用可能计费。
4. 查看反馈、各项分数、来源和保存的提交快照，再重新练习。选择题得分仍由本地标准答案决定；主观题逐项校验 rubric 后汇总。绘图仅提供坐标/连线信息，不具备图像视觉理解或权威图形评分能力。

未配置、离线、鉴权失败、额度不足、限流、超时或无效模型回复会明确报错；保留草稿，不写入虚假成绩，也不悄悄改用本地评分。不会自动重试收费请求。可以主动选择本地规则继续。

验证分两层：仓库的模拟网络测试验证请求格式、同意门禁、失败处理、rubric 校验及保存/恢复；这些测试不会访问 DeepSeek，也不能证明实际凭据和服务连通。真实联网验收需用户本人先完成安全凭据配置，并逐次同意一次合成练习数据提交，然后确认结果、历史和错误状态。不要把模拟通过写成已完成真实 API 验收。

官方文档：[Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/) · [JSON Output](https://api-docs.deepseek.com/guides/json_mode/)。现有 stdio MCP 工具仍使用本地规则，不会因桌面云评阅配置而自动发送数据。

## 目录与边界

```text
src/components/    文科组装、数学交互工具、地理绘图与学习热力图
src/domain/        schema、示例题、答题服务、坐标计算
src/adapters/      题库、规则 Agent、MCP 客户端、原子 JSON 存储
src/shared/        UI / preload / 主进程共享类型
electron/         窗口、受限 IPC、preload
mcp/              stdio 服务与固定作用域
tests/            领域、持久化、坐标、真实 MCP 通信及桌面 E2E
```

渲染器开启 sandbox / contextIsolation，禁用 Node integration；只暴露具体业务方法，不暴露通用 IPC、文件路径或 shell。主进程校验 IPC 来源，生产页面走受限 `examcraft://` 协议，禁止外部导航、弹窗、webview 和权限请求。生产 CSP 禁止脚本内联与联网；开发模式只允许本地 Vite、热更新和匹配 nonce 的脚本。参考 [Electron 安全指南](https://www.electronjs.org/docs/latest/tutorial/security) 与 [MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/)。

## 验证

```sh
npm run typecheck
npm test
npm run build
npm run test:e2e
```

`npm test` 包括嵌套论证与最终正文校验、学习热力图统计、数学表达式与测量校验、草稿/快照恢复、模拟云请求同意门禁，以及实际 MCP 客户端/服务端握手及范围测试；`test:e2e` 构建后启动真正的 Electron，覆盖选择题、文科嵌套模块编辑、数学交互、学习热力图、地理绘图、题库导入、重启恢复及开发 CSP。测试使用独立临时用户目录，不读写你的学习记录。桌面测试需要图形环境；Linux 可用 `xvfb-run -a npm run test:e2e`。无需单独下载 Playwright 浏览器。

CI 在 Windows 和 Ubuntu 执行类型检查、单元/MCP 测试和构建，在 Windows 执行 Electron E2E。

## 尚未实现

- 基于授权历年真题的检索/出题；当前只有原创示例与用户自行导入题库。
- PDF/OCR 批量导入、去重相似题、大型数据库索引。
- 图形语义评判、地图底图、球面投影、自由画笔和 SVG 导出。
- 自适应复习、完整成绩统计分析。
- GUI 中配置/启动外部 MCP 服务器、凭据管理。
- 安装包、代码签名、自动更新、云同步、自动备份。
- macOS / Linux 的实际桌面人工验收；当前本地验证平台为 Windows。

License: [GPL-3.0](LICENSE).
