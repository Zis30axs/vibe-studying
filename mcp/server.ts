import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { isAbsolute } from 'node:path'
import { readJsonFile } from '../src/adapters/atomic-json-store'
import { LocalQuestionBank } from '../src/adapters/local-question-bank'
import { LocalRuleAgent } from '../src/adapters/local-rule-agent'
import { questionBankSchema, scopeSchema } from '../src/domain/schemas'
import { sampleQuestions } from '../src/domain/sample-bank'
import { createExamCraftMcpServer } from './create-server'

export function parseArguments(args: string[]) {
  let bankPath: string | undefined
  let subject: string | undefined
  let referenceAccess: 'student' | 'full' | undefined
  const tags: string[] = []
  const questionIds: string[] = []
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`)
    switch (flag) {
      case '--reference-access':
        if (referenceAccess) throw new Error('Use --reference-access only once')
        if (value !== 'student' && value !== 'full')
          throw new Error('--reference-access must be student or full')
        referenceAccess = value
        break
      case '--bank':
        if (bankPath) throw new Error('Use --bank only once')
        bankPath = value
        break
      case '--subject':
        if (subject) throw new Error('Use --subject only once')
        subject = value
        break
      case '--tag':
        tags.push(value)
        break
      case '--question-id':
        questionIds.push(value)
        break
      default:
        throw new Error(`Unknown argument: ${flag}`)
    }
  }
  if (bankPath && !isAbsolute(bankPath))
    throw new Error('--bank must be an absolute JSON file path')
  const scope = scopeSchema.parse({
    subject,
    ...(tags.length ? { tags } : {}),
    ...(questionIds.length ? { questionIds } : {}),
  })
  return { bankPath, scope, referenceAccess: referenceAccess ?? 'student' }
}

async function main(): Promise<void> {
  const { bankPath, scope, referenceAccess } = parseArguments(process.argv.slice(2))
  // A supplied bank is an explicit snapshot. The MCP process never writes desktop data.
  const questions = bankPath
    ? questionBankSchema.parse(await readJsonFile(bankPath)).questions
    : sampleQuestions
  const server = createExamCraftMcpServer(
    new LocalQuestionBank(undefined, questions),
    new LocalRuleAgent(),
    scope,
    { referenceAccess },
  )
  await server.connect(new StdioServerTransport())
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
