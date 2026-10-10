# ExamCraft

一款 **Electron + React + TypeScript** 学科 IDE。把选择题练习、政治论证模块和地理坐标图放进同一个本地学习空间。

首个 MVP 的完整闭环：**选题 → 作答 / 自动保存草稿 → 提交 → 规则反馈与解析 → 查看历史 → 重做**。无需账号或 API Key，安装完成后可离线练习。仓库原有 GPL-3.0 许可证保留。

![ExamCraft 桌面练习界面](docs/screenshots/practice.png)

## 本地运行

需要 Node.js **22.12+（推荐 24 LTS）**、npm，以及支持 Electron 的桌面系统。首次安装/启动需要联网下载 npm 依赖与 Electron 二进制。

```sh
git clone https://github.com/Zis30axs/vibe-studying.git
cd vibe-studying
git switch feat/examcraft-mvp
npm ci
npm run dev
```

开发模式同时启动 Vite 和 Electron；React 页面支持热更新，修改 `electron/` 或 `mcp/` 后需重启。`npm run dev:web` 仅供调试页面服务，完整功能需要 Electron 的本地 API。

构建并启动生产页面：

```sh
npm run build
npm start
```

`build` 生成 `dist/`、`dist-electron/`、`dist-mcp/`，不是安装包。`start` 需要先构建。若首次 Electron 下载失败，可在网络恢复后运行 `npx --no install-electron`。

## 试用顺序

1. **题目练习**：选择“从实践中发现问题”，选一个选项、写下理由、提交。选择题按标准答案判分；解析只在提交后的界面展示。
2. **练习记录**：查看本次答案、时间、得分和解析；重新练习会新增记录，保留先前提交。
3. **政治组装**：把原理、材料、分析、结论模块加入答案；改写内容、调整顺序或创建空白模块，再提交自查。
4. **地理工作台**：切换经纬度，添加 A(20,30)、B(40,50)，连线并解释方向。支持精确坐标输入、鼠标描点、编辑、删除、撤销；换坐标系需要确认清空。
5. 关闭再打开应用，草稿和提交历史仍保留。右上角可导入 `examples/question-bank.json`，然后搜索“导入示例”。

内置 6 道题均为**原创演示题，非历年真题**。主观题的“分数”只是关键词规则自查结果，不判断否定、语义、论证顺序或图形是否正确，不能当作考试评分。绘图和模块编辑均保存在提交快照中。

## 数据与题库

数据保存在 Electron 的 `app.getPath('userData')` 下：

- Windows：通常为 `%APPDATA%/ExamCraft/`
- macOS：通常为 `~/Library/Application Support/ExamCraft/`
- Linux：通常为 `~/.config/ExamCraft/`
- `study-state.json`：草稿与全部提交快照。
- `question-bank.json`：导入的题目；不包含内置题。

写入经队列串行化，先写临时文件并同步，再原子替换；关窗等待在途草稿/提交落盘。损坏或不兼容文件会报错并保留原文件，不会静默重置。备份时先退出应用，再复制整个数据目录；当前没有自动备份或数据迁移工具。每个 JSON 文件上限 8 MiB，总题目数上限 1000（包括内置 6 道）；达到限制时拒绝新写入并保留原数据。

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

`subject` 为 `politics` / `geography`；`kind` 为 `choice` / `politics` / `geography`。主观题必须提供 `rubric`（`id`、`label`、`keywords`、`points`），分值之和等于 `maxScore`；政治题可提供 `blocks`（`id`、`category`、`label`、`text`）。模板见 [sample-bank.ts](src/domain/sample-bank.ts)。仅导入你有权使用的题目，来源字段用于追溯。

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

| 参数                                          | 作用                                                 |
| --------------------------------------------- | ---------------------------------------------------- |
| `--subject politics` 或 `--subject geography` | 限定学科                                             |
| `--tag 经纬网`                                | 限定标签；可重复，多个标签取交集                     |
| `--question-id geo-choice-1`                  | 限定题号；可重复，多个 ID 取并集，再与其他条件取交集 |
| `--bank /absolute/path/bank.json`             | 使用指定题库快照，替代内置题库；路径必须绝对         |

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

适配器接口位于 [contracts.ts](src/adapters/contracts.ts)：

- `QuestionBankAdapter`：`list(scope)` / `get(id, scope)`。
- `AgentAdapter`：`review(question, draft)`。
- `LocalQuestionBank` / `LocalRuleAgent`：当前默认实现。
- `McpQuestionBankAdapter` / `McpAgentAdapter`：接受宿主已连接的可信 MCP `Client`，校验工具返回值。不会接受题库中提供的命令或自动启动未知程序。

后续接入模型时，在主进程中替换 `StudyService` 的 Agent；密钥与网络调用留在主进程，保留反馈结构校验。当前没有外部模型连接设置或 AI 出题功能。

## 目录与边界

```text
src/components/    政治组装与地理绘图
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

`npm test` 包括实际 MCP 客户端/服务端握手及范围测试；`test:e2e` 构建后启动真正的 Electron，覆盖选择题、政治编辑、地理绘图、题库导入、重启恢复及开发 CSP。测试使用独立临时用户目录，不读写你的学习记录。桌面测试需要图形环境；Linux 可用 `xvfb-run -a npm run test:e2e`。无需单独下载 Playwright 浏览器。

CI 在 Windows 和 Ubuntu 执行类型检查、单元/MCP 测试和构建，在 Windows 执行 Electron E2E。

## 尚未实现

- 接入真实 LLM、语义评分、基于授权历年真题的检索/出题。
- PDF/OCR 批量导入、去重相似题、大型数据库索引。
- 图形语义评判、地图底图、球面投影、自由画笔和 SVG 导出。
- 模块拖拽（当前用按钮排序）、自适应复习、成绩统计分析。
- GUI 中配置/启动外部 MCP 服务器、凭据管理。
- 安装包、代码签名、自动更新、云同步、自动备份。
- macOS / Linux 的实际桌面人工验收；当前本地验证平台为 Windows。

License: [GPL-3.0](LICENSE).
