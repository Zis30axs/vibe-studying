# Custom model transport and privacy

## Supported HTTP shapes

The model settings Base URL is the API prefix, not a complete operation URL. A local change to protocol, URL, model or key increments the global configuration revision and invalidates in-flight requests. A new request must have either one-off consent or locally remembered consent covering the same canonical receiver and data categories. There is no automatic provider discovery or network call when settings are saved.

| Protocol                | Typical Base URL                                   | Appended operation                        | Authentication                               |
| ----------------------- | -------------------------------------------------- | ----------------------------------------- | -------------------------------------------- |
| Anthropic Messages      | `https://api.anthropic.com/v1`                     | `/messages`                               | `x-api-key`, `anthropic-version: 2023-06-01` |
| Gemini generateContent  | `https://generativelanguage.googleapis.com/v1beta` | `/models/{encoded-model}:generateContent` | `x-goog-api-key` header                      |
| OpenAI Responses        | `https://api.openai.com/v1`                        | `/responses`                              | Bearer header                                |
| OpenAI Chat Completions | `https://api.openai.com/v1`                        | `/chat/completions`                       | Bearer header                                |

DeepSeek migration defaults to the Chat Completions protocol at `https://api.deepseek.com`, model `deepseek-flash`. An existing process-start DeepSeek environment key can bootstrap that target only while no profile vault exists. It cannot override or resurrect an explicitly saved, locked, session-only or cleared profile on restart. The app never loads other providers' ambient credentials. Named profiles can retain keys in main-process memory for one session, or explicitly persist OS-encrypted ciphertext. Electron safeStorage is used after readiness; Linux basic_text and unknown backends are rejected. Failed encryption does not fall back to plaintext; failed decryption marks a profile locked. No raw/ciphertext getter is exposed to the renderer. Keys are bound to profile identity, protocol and canonical endpoint inside the encrypted envelope; changing protocol or endpoint clears them unless a replacement is supplied. Profiles, assignments and ciphertext commit atomically in model-profiles.json, separately from study data.

The provider must support text JSON output and the selected operation. Model IDs are user-configurable; not every model supports every operation or JSON mode. Replies must be completed text-only JSON. Truncation, refusals, safety blocks, tool/function calls, unsupported reasoning output, malformed envelopes, or malformed review/advisor JSON are rejected. These existing one-shot task endpoints do not execute tool calls. The separate Agent workbench uses ModelToolTransport for native tool calls, trusted registry execution and bounded result-return turns; it does not weaken the text-JSON endpoints. Responses requests explicitly set `store: false`; third-party provider retention policies still apply.

## Information sent

- Review: current question, reference and rubric, current final answer, logical argument roots or legacy answer blocks, relevant drawing/math state, and an optional supplied syllabus. Canvas positions/viewport, prior attempts, account identity, GitHub profile, unrelated questions and files are excluded.
- Ask Advisor: the explicit selected excerpt, its source category, and necessary trusted question context resolved by ID. Reference explanation/answer key/rubric are added only when this request explicitly authorizes includeReference. It does not send full drafts, conversation history, account data or files. It returns a hint separately and never inserts it into the student's answer automatically.
- The advisor instruction calls for limited prompts and conceptual hints, never a full answer. This is a model behavior constraint, not a guarantee of provider correctness. The output remains untrusted text.

Each request checks explicit consent and the saved configuration revision. A pending request uses an immutable target/key snapshot. Advisor request IDs support cancellation; changing configuration cancels pending advisor requests. Remembering is an explicit optional choice, separately recorded in model-consents.json. Categories distinguish grading, generation, selection advice, module checking, additional reference material, and explicitly chosen knowledge excerpts. Same-receiver model/question changes may reuse matching remembered grants; different receivers or new categories may not. Revocation clears inherited checkmarks across controls and cancels unfinished calls; if the disk write fails, denial remains active in the main process, including after renderer reload, and the user is told to retry before fully restarting the app. Selecting excerpts and accepting proposed edits are still explicit actions.

## Transport safeguards

Only HTTPS named public hosts are accepted. Embedded credentials, query strings, fragments, unusual ports, IP literals, local/metadata names and unsafe URL paths are rejected. The actual HTTPS connection's DNS lookup rejects private, loopback, link-local, reserved and multicast addresses; resolution is checked inside connection establishment rather than in a separate check vulnerable to DNS rebinding. All returned addresses must pass. Redirects are never followed, so an authentication header cannot be forwarded to a redirect target.

A 60-second deadline includes response-body consumption and cancellation. Responses are limited to 256 KiB. JSON is parsed and structurally validated before use; earned rubric points are bounded by the local authoritative rubric and totals are computed locally. No raw provider body, validation input, URL, network error or credential is included in user-facing errors or logs. Credential echoes are rejected. The renderer retains no key after settings are submitted.

## Explicit model discovery and diagnostics

Model discovery and connection testing happen only when clicked. Discovery uses GET /models with protocol-specific authentication and Gemini/Anthropic pagination; only supported generateContent Gemini models are offered. It is bounded to 5 pages, 500 models and 256 KiB per response under one deadline; overlarge/incomplete results fail explicitly. Users may manually enter an ID. A successful list is not evidence that a chosen model can be invoked.

The connection probe sends only fixed synthetic text with a 32-output-token limit. Chat probes use the same max_tokens parameter as task calls, preserving DeepSeek-compatible behavior; this mode does not support OpenAI o-series models that require max_completion_tokens. It can incur a small provider charge and does not confirm JSON task compatibility or model quality. New endpoints cannot implicitly receive saved keys. Results are tied to request ID/configuration revision; edits, switching, cancellation and deletion suppress late results.

Opt-in Debug records at most 80 sanitized events in main-process memory, with locally generated request UUIDs, fixed stage/category, duration, protocol/model, optional HTTP status and allowlisted schema paths. It never stores request/response bodies, provider error strings, URL queries, headers, credentials, student answers or textbook content. Disabling Debug clears it; restart starts disabled. Copying diagnostics copies only this bounded safe projection. Debug never retries a request or transmits data externally.

## Official protocol references

Consulted before implementation:

- [DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)
- [DeepSeek parameter compatibility](https://api-docs.deepseek.com/quick_start/agent_integrations/oh_my_pi/)
- [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)
- [Anthropic Models](https://platform.claude.com/docs/en/api/models/list)
- [Gemini Models](https://ai.google.dev/api/models)
- [OpenAI Models](https://developers.openai.com/api/reference/resources/models/methods/list)
- [Anthropic Create a Message](https://platform.claude.com/docs/en/api/messages/create)
- [Gemini generateContent](https://ai.google.dev/api/generate-content)
- [Gemini authentication](https://ai.google.dev/api)
- [OpenAI Create a model response](https://developers.openai.com/api/reference/resources/responses/methods/create)
- [OpenAI Create chat completion](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)

`tests/model-protocols.test.ts` injects mocked transports with synthetic credentials only, covering all four protocols for review and advisor, unsafe endpoints, rejected responses, malformed scores, cancellation and timeout. No live model calls are required for testing. Desktop integration tests must intercept `node:https.request` as well as legacy `fetch`; the production transport intentionally uses its own DNS-checked HTTPS connection.

## Restrained module review

The module-review prompt explicitly permits no suggestions, rejects blanket stylistic nitpicking, limits output to five high-value issues and three grounded confirmations, and distinguishes must-fix, optional and uncertain findings. Uncertain findings cannot carry edits. Missing rubrics cannot be invented.

Only the consented question/subject, selected logical roots (or all roots) and optional validated text spans are sent. Reference explanation/rubric require the separate per-request includeReference authorization and are resolved by the main process; the renderer cannot supply or fetch raw teacher fields. Canvas geometry, revision trees, final prose and account data are excluded. Full displayed module text remains context in span-focused mode. Each proposed replacement is bound to an existing module ID, exact base text, UTF-16 offsets, expected substring and length limits; application repeats validation against the current document. It never executes model-generated actions or changes logical connections. No live provider quality guarantee follows from these constraints.

Accepted edits create immutable local checkpoints. The persistent tree keeps parent IDs and branches after restoration, bounded to 40 snapshots and 1 MiB; overflow fails without deleting old branches. Final prose is not part of module restoration.

## Role boundaries

StudentQuestion is a runtime allowlist at the list IPC boundary, excluding explanation, correctAnswer, rubric and reference blocks. It is not merely a TypeScript cast or hidden UI. Advisor and module review submit a question ID; main-process lookup validates the ID and constructs their payload independently. Both generic and legacy graders use buildGradingContext with immutable submitted evidence and no Advisor history or UI state. StudyService captures input before asynchronous resolution and gives reviewers separate frozen copies, preserving the submission snapshot even if later workspace edits occur.

The same renderer can display permitted post-submission reviews and Advisor output; this is not a claim of OS/process sandboxing between panels or a guarantee that a model never repeats reference content. Local file owners can inspect their own question banks. MCP reference access is an independent startup scope; see mcp-roles.md.

## Bounded geography generation

Generation is a separate explicit operation using only syllabus/chapter/difficulty and a fixed constrained generation prompt. No learner draft, Advisor dialogue, previous grades, account profile or reference bank is sent. It uses the same four bounded transports and per-request target/revision consent. At most one request runs, five are dispatched per application session (including dispatched failures/cancellations), and three unaccepted previews are retained. There is no automatic paid retry.

The provider may return only typed schematic data and private explanation/rubric. Main process validates coordinates/counts/IDs/references and nonempty, sum-consistent rubric; it creates IDs, provenance and source itself. Preview is a StudentQuestion projection with no teacher fields. Accepting a private token is a separate atomic local bank import. Duplicate normalized stems are rejected; rejected previews do not alter the bank. Accepted questions persist, and submission records include an immutable student-safe question/diagram snapshot.

Safe schematic primitives do not imply factual validity, solvability or authoritative scoring. No generated SVG, HTML, JavaScript, URLs, external images or arbitrary model tool calls are executed. Advisor and grading contexts can receive the safe question figure as necessary evidence; they retain their existing reference/history separation.

## Native Agent workbench

The primary profile orchestrates up to three native model turns and six allowlisted tools per run. Formal review and geography generation use the primary profile; selection advice and module checks use the child profile, with at most two single-request delegations total. Native loops never recurse through delegated tools. The aggregate run deadline is 120 seconds and the app-session Agent dispatch budget is 30. Actual HTTP dispatches and delegated attempts are counted; no automatic paid retry occurs. Cancellation/profile changes invalidate old runs and their proposals.

Anthropic tool_use/tool_result, Gemini functionCall/functionResponse, OpenAI Responses function_call/function_call_output and Chat tool_calls/tool_call_id are adapted independently. Required Gemini signatures, Responses reasoning items and DeepSeek reasoning_content are held only in bounded main-process continuation state, scanned for reflected keys, never shown or logged, and paired with single-use continuation capabilities. Tool IDs, names, argument/result sizes, shapes and total context are validated. Built-in server tools, arbitrary network/file access, dynamic application-method dispatch and unknown calls are rejected.

New agent/agent_answer/agent_reference/agent_knowledge consent categories do not silently expand earlier remembered grants. Main-process scope fixes subject, question IDs, selected current-answer snapshot, reference permission, textbook document and physical page range. Tool outputs derived from reference/textbook data require permission for the main recipient as well as any child recipient receiving them. get/list question tools always return student-safe data. Textbook disclosure is capped at three distinct 1200-character excerpts cumulatively per run. localDraft is a local provenance baseline and is never a model payload by itself.

A newly proposed question can show its newly generated canonical answers in the explicit create-only local confirmation UI; native tool output still gets only its student-safe preview and proposal ID. No existing question reference is exposed through that proposal path. Answer edits and question imports require separate user confirmation; answer merges validate the full current baseline and persist the real change before recording a merge.

Official native format references: [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling), [Anthropic tool results](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls), [Gemini function calling](https://ai.google.dev/gemini-api/docs/function-calling), [DeepSeek thinking/tool state](https://api-docs.deepseek.com/guides/thinking_mode/). Provider/model compatibility is demonstrated only with synthetic fixtures here, not real credentials.

## 公开网络工具

Agent 的 `web_search` / `web_fetch` 可供主模型和实际委派的子模型调用；子模型只暴露这两个已启用工具，不可递归委派或使用额外题目/文件工具。子模型最多一次结果续接，计入同一任务两次委派模型请求、六次工具调用和总超时。网络检索/抓取额度也是同一个会话对象，不能通过切换角色重置。固定公开检索范围、来源编号和明确网址不取自答卷/教材/任务自由文本；供应商与模型接收方分别按新增数据类别授权。参见 [公开网络工具](web-research.md)。
