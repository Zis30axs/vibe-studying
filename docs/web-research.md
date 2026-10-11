# Bounded public-web research (v0.4.0)

ExamCraft implements **Tavily basic Search** plus a **direct HTTPS text fetcher**. It does not claim support for other search providers, Tavily Extract, browser rendering, PDF downloads, crawling, automatic redirects, or authentication to source websites. The normal workflow remains offline unless the user enables and confirms public research for that run.

## Verified provider contracts

Reviewed official documentation on **2026-10-11**, without a live API request or real credentials:

- [Tavily Search endpoint](https://docs.tavily.com/documentation/api-reference/endpoint/search): POST to `https://api.tavily.com/search`, using a Bearer API key. Basic search costs one credit. ExamCraft explicitly sets `search_depth: basic`, `auto_parameters: false`, `topic: general`, `chunks_per_source: 1`, `max_results: 5`, and `include_usage: true`. Generated answers, raw content, images, and favicons are disabled. Returned snippets remain untrusted and may be inaccurate. The API documents 401 authentication errors, 429 rate limits, and 432/433 account usage limits; ExamCraft maps these to fixed credential-free messages and never retries automatically.
- [Tavily Extract endpoint](https://docs.tavily.com/documentation/api-reference/endpoint/extract): POST `/extract` accepts URLs, extraction depth, plain text/Markdown format, and optional chunk reranking. HTTP 200 can still contain failed URLs or no successful results; both result arrays matter. `include_usage` may report zero before five successful extractions accumulate. ExamCraft does **not** expose Extract: validating a submitted URL locally cannot control the provider's subsequent DNS resolution, redirects, or subrequests. The documented endpoint does not provide the connection-pinning/no-redirect contract this product requires. This is a limitation of what this integration can enforce, not a claim that Tavily is unsafe.
- [Tavily credits and pricing](https://docs.tavily.com/documentation/api-credits): Basic Search is one credit per request; advanced Search is two. Basic Extract charges one credit per five successful URLs; advanced charges two, and failed extractions are not charged. The free allocation is 1,000 credits/month; published pay-as-you-go is USD 0.008/credit. User account terms and balances determine actual charges. These numbers are documentation snapshots, not a guarantee or an authorization to upgrade, subscribe, or spend beyond the run's request limit.

## Public-data boundary

The user confirms these labels explicitly: subject, topic/chapter, region, and one to five years. They can optionally approve up to three specific public URLs. A shared, deterministic query builder previews exactly the full query and the permitted single-year variants. Neither model can supply arbitrary search text. No student answer, textbook excerpt, prompt, conversation, local document, credential, or model-generated query is added to outgoing queries. Labels are short and constrained, but the UI confirmation remains necessary: syntax validation cannot determine whether a human has entered private text.

Search arguments are only `{ year? }`, limited to the confirmed years. Fetch arguments are only `{ sourceId }`. Source IDs are unique to a run; they refer to that run's search results or the user's specifically approved URLs. A URL in a model response, local document, another session, or search-result instructions does not authorize a request. An approved URL placeholder has `retrieved: false`, a null retrieval date, and no excerpt/year evidence until it succeeds.

Parent/child tools share one session and budget: at most **two Search requests and two direct fetches**. Distinct calls reserve budget before I/O. Repeated/concurrent equivalent requests share their existing outcome, including failures and cancellation, and never silently spend again. Cancellation after sending may still incur provider charges. Reported credits are provider metadata, not a verified bill; the local estimate is the number of Search requests attempted. Direct fetches use no Tavily credits.

## Transport and storage

Both network paths use Node's direct HTTPS client. DNS is checked in the actual connection lookup, rejecting the entire answer set if any address is private or special-purpose; the checked addresses are the addresses given to that socket. Connections do not use a pooled agent or follow redirects. HTTPS uses its ordinary hostname/certificate verification. Literal IP addresses, local hostnames, URL credentials, nondefault ports, fragments, malformed URLs, and secret-like query parameters are rejected. No Tavily key, cookie, referrer, or model credential is sent to fetched sources. The Tavily key is bound to the fixed Search endpoint, not a configurable base URL.

The transport uses a bounded timeout/cancellation signal and a 256 KiB response ceiling. Both declared and streamed sizes are checked. It accepts uncompressed UTF-8 JSON for Search and UTF-8/plain ASCII HTML or plain text for Fetch. HTML is converted to inert plain text without executing scripts or loading subresources. It does not read PDFs, images, binary files, compressed responses, legacy character encodings, or redirect destinations. It rejects reflected credentials, including common JSON escaping, HTML entity encoding, base64 and hex forms. This defense is not a promise to detect every conceivable malicious encoding.

A dedicated main-process `WebResearchStore` uses `web-research-credentials.json` outside workspace data/exports. The default is session-only storage. Persistent saving requires explicit opt-in and Electron's OS-backed `safeStorage` adapter; unavailable/locked storage fails closed without plaintext fallback. The encrypted envelope binds provider and endpoint. Renderer IPC receives only provider/revision/configured/key status/secure-storage availability. Neither raw keys nor ciphertext are exposed. Stale revisions are rejected. Clearing removes session and persisted credentials; corrupt storage is preserved for recovery instead of overwritten.

## Evidence, attribution, and limits

Only short excerpts (up to 1,200 characters/source), bounded titles, canonical URLs, retrieval dates, and exact nearby year mentions leave the provider adapter. Search and fetch outputs are explicitly untrusted and unverified. A source mentioning a year is not proof of an exam's year, authenticity, official publisher, or official answer. Search relevance and provider rank confer no authority. Missing, unsafe, inaccessible, or unsupported sources must remain missing; the model must not invent replacements or claim they were retrieved.

The generated-question pipeline stores bounded source attribution, not whole exams or fetched page text. Authenticity claims require independent evidence; generated material should be described as original/adapted/unverified-source as appropriate. Source content is data, never instructions to change scope, reveal credentials, run tools, or weaken policy.

## Verification

`tests/web-research-provider.test.ts` uses synthetic fetch/DNS/socket mocks only. It covers URL/IP rejection, mixed public/private DNS answers, connection pinning, fixed endpoint/parameters, no credential transmission to sources, schema bounds, injection-shaped arguments, reflection, cancellation before/during I/O, stalled bodies, late completions, duplicate calls, budgets, redirects, media types and sanitized errors.

`tests/web-research-store.test.ts` covers separate credential scope, session restart behavior, OS-encrypted persistence, masked projections, locked storage, incorrect envelope bindings, stale/concurrent writes, blank-retain/clear behavior, corrupt files, no temporary-file leakage, restrictive creation mode and rejection of plaintext/base64-plaintext fallback.

No actual Tavily request, real billing measurement, external DNS/socket connection, or live provider authentication was exercised. End-to-end availability and current account credit behavior require a user-authorized live test with their own account. No real secret is required or appropriate for the repository test suite.
