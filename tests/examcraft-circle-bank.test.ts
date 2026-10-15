/** Native schema and importer regression tests; writes only synthetic temporary data. */
import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { questionBankSchema } from '../src/domain/schemas'
import { studentQuestionProjection } from '../src/domain/student-question'
import { LocalQuestionBank } from '../src/adapters/local-question-bank'

const bankPath = process.env.EXAMCRAFT_CIRCLE_BANK ?? resolve('examples/circle-tangent-bank.json')
const input: unknown = JSON.parse(readFileSync(resolve(bankPath), 'utf8'))

describe('delivered 30-question circle-and-tangent bank', () => {
  it('passes the original current questionBankSchema without normalization changes', () => {
    const bank = questionBankSchema.parse(input)
    expect(bank).toEqual(input)
    expect(bank.version).toBe(1)
    expect(bank.questions).toHaveLength(30)
    expect(bank.questions.filter((q) => q.kind === 'math')).toHaveLength(28)
    expect(bank.questions.filter((q) => q.kind === 'choice')).toHaveLength(2)
    const allIds = bank.questions.flatMap((q) => [q.id, ...(q.rubric ?? []).map((r) => r.id)])
    expect(new Set(allIds).size).toBe(allIds.length)
    for (const q of bank.questions) {
      expect(q.subject).toBe('math')
      expect(q.id).toMatch(/^ecag-circle-20261015-q\d{2}$/)
      expect(q.maxScore).toBe(10)
      if (q.kind === 'math') {
        expect(q.rubric).toHaveLength(4)
        expect(q.rubric!.reduce((n, r) => n + r.points, 0)).toBe(10)
      }
      expect(q.blocks).toBeUndefined()
      expect(q.geometry).toBeUndefined()
    }
  })

  it('keeps reference fields out of the original student projection', () => {
    const bank = questionBankSchema.parse(input)
    for (const q of bank.questions) {
      const student = studentQuestionProjection(q)
      for (const hidden of ['explanation', 'correctAnswer', 'rubric', 'blocks']) {
        expect(Object.hasOwn(student, hidden)).toBe(false)
      }
      expect(student.prompt).toBe(q.prompt)
    }
  })

  it('imports only into a temporary bank; preserves fixture records; rejects repeat import atomically', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'examcraft-circle-bank-'))
    try {
      const bank = questionBankSchema.parse(input)
      const local = new LocalQuestionBank(directory, [])
      // This is synthetic test data, never a real user's study-state file.
      const studyPath = join(directory, 'study-state.json')
      const sentinel = JSON.stringify({ fixtureOnly: true, marker: 'must-remain-byte-identical' })
      await writeFile(studyPath, sentinel, 'utf8')
      const existing = { ...structuredClone(bank.questions[0]), id: 'fixture-existing-question' }
      expect(await local.importBank({ version: 1, questions: [existing] })).toBe(1)
      expect(await local.importBank(bank)).toBe(30)
      const after = await local.list()
      expect(after).toHaveLength(31)
      expect(after.find((q) => q.id === existing.id)).toEqual(existing)
      expect(await readFile(studyPath, 'utf8')).toBe(sentinel)
      const bankBeforeRepeat = await readFile(join(directory, 'question-bank.json'), 'utf8')
      await expect(local.importBank(bank)).rejects.toThrow(/ID 已存在/)
      expect(await readFile(join(directory, 'question-bank.json'), 'utf8')).toBe(bankBeforeRepeat)
      expect(await readFile(studyPath, 'utf8')).toBe(sentinel)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
