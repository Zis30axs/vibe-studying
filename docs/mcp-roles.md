# MCP question and reference roles

MCP reference access is fixed when the server starts. The default is `student`:

```sh
node dist-mcp/server.cjs --subject geography --reference-access student
```

`list_questions` and `get_question` then return only the explicit `StudentQuestion`
allowlist: ID, subject, kind, title, prompt, source, tags, maximum score, and choice
IDs/text. They omit `explanation`, `rubric`, `correctAnswer`, and all reference
`blocks` (including their labels and IDs). New private fields are not automatically
included. Tool arguments cannot promote this startup setting. Subject, tag, and
question-ID filters only narrow the startup scope in either mode.

A trusted question-bank host requiring the complete `Question` contract must opt in:

```sh
node dist-mcp/server.cjs --reference-access full --subject geography
```

`McpQuestionBankAdapter` intentionally requires that complete contract and reports
missing reference access if connected to a student server. Do not attach a full
server to a solver, answer-writing agent, or Advisor context. Programmatic hosts use
`createExamCraftMcpServer(bank, agent, scope, { referenceAccess: 'full' })`; the
existing first three parameters retain their meaning and default to student access.

## Submission is a separate capability

`review_answer` always validates a submitted answer and enforces the startup question
scope. Its grading result deliberately contains explanation and rubric feedback;
an incorrect choice may reveal the correct answer. It does not persist a desktop
attempt. Student reference mode restricts question reads, **not** the review tool.
A host that exposes review to an agent lets that agent submit a guess and obtain
feedback. Grant review only to the explicit submitted-answer grading role. Merely
using `student` mode is not sufficient to isolate a solver granted all MCP tools.

The desktop answer workspace and Advisor do not have a generic MCP tool bridge.
They receive projected question data through the local application boundary.
Grading retains full questions in the trusted backend and returns feedback only
through the submission/review path. Existing reviewed attempts can contain
references; they must not be added to a new solver/Advisor request.

## Limits

This is role/data minimization, not authentication, exam proctoring, or protection
against the computer owner. The local question-bank file and an explicitly started
full-mode external MCP server still contain references. A host must select its
allowed tools and contexts correctly. Student-facing prompt/source/choice text
also remains authored question-bank content, not a guarantee that the author has
never embedded an answer in a public field.
