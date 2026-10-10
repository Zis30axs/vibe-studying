# Custom model transport and privacy

## Supported HTTP shapes

The model settings Base URL is the API prefix, not a complete operation URL. A local change to protocol, URL, model or key increments the configuration revision and requires fresh send consent. There is no automatic provider discovery or network call when settings are saved.

| Protocol                | Typical Base URL                                   | Appended operation                        | Authentication                               |
| ----------------------- | -------------------------------------------------- | ----------------------------------------- | -------------------------------------------- |
| Anthropic Messages      | `https://api.anthropic.com/v1`                     | `/messages`                               | `x-api-key`, `anthropic-version: 2023-06-01` |
| Gemini generateContent  | `https://generativelanguage.googleapis.com/v1beta` | `/models/{encoded-model}:generateContent` | `x-goog-api-key` header                      |
| OpenAI Responses        | `https://api.openai.com/v1`                        | `/responses`                              | Bearer header                                |
| OpenAI Chat Completions | `https://api.openai.com/v1`                        | `/chat/completions`                       | Bearer header                                |

DeepSeek migration defaults to the Chat Completions protocol at `https://api.deepseek.com`, model `deepseek-flash`. An existing process-start DeepSeek environment key can initialize that target only. The app never loads other providers' ambient credentials. New user-entered keys remain in main-process memory, are never returned from IPC, and are not persisted. Restarting requires entering them again. Changing protocol or endpoint clears the key unless a replacement is supplied.

The provider must support text JSON output and the selected operation. Model IDs are user-configurable; not every model supports every operation or JSON mode. Replies must be completed text-only JSON. Truncation, refusals, safety blocks, tool/function calls, unsupported reasoning output, malformed envelopes, or malformed review/advisor JSON are rejected. No tool execution or follow-on agent call is implemented. Responses requests explicitly set `store: false`; third-party provider retention policies still apply.

## Information sent

- Review: current question, reference and rubric, current final answer, logical argument roots or legacy answer blocks, relevant drawing/math state, and an optional supplied syllabus. Canvas positions/viewport, prior attempts, account identity, GitHub profile, unrelated questions and files are excluded.
- Ask Advisor: the explicit selected excerpt, its source category, and necessary trusted question context resolved by ID. Reference explanation/answer key/rubric are added only when this request explicitly authorizes includeReference. It does not send full drafts, conversation history, account data or files. It returns a hint separately and never inserts it into the student's answer automatically.
- The advisor instruction calls for limited prompts and conceptual hints, never a full answer. This is a model behavior constraint, not a guarantee of provider correctness. The output remains untrusted text.

Each request checks explicit consent and the saved configuration revision. A pending request uses an immutable target/key snapshot. Advisor request IDs support cancellation; changing configuration cancels pending advisor requests. Consent must be obtained again for a changed selection or changed destination.

## Transport safeguards

Only HTTPS named public hosts are accepted. Embedded credentials, query strings, fragments, unusual ports, IP literals, local/metadata names and unsafe URL paths are rejected. The actual HTTPS connection's DNS lookup rejects private, loopback, link-local, reserved and multicast addresses; resolution is checked inside connection establishment rather than in a separate check vulnerable to DNS rebinding. All returned addresses must pass. Redirects are never followed, so an authentication header cannot be forwarded to a redirect target.

A 60-second deadline includes response-body consumption and cancellation. Responses are limited to 256 KiB. JSON is parsed and structurally validated before use; earned rubric points are bounded by the local authoritative rubric and totals are computed locally. No raw provider body, validation input, URL, network error or credential is included in user-facing errors or logs. Credential echoes are rejected. The renderer retains no key after settings are submitted.

## Official protocol references

Consulted before implementation:

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
