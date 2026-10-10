import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { transformSync } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { activityIntensity, buildActivityDays, localActivityKey } from '../src/domain/activity'
import { ActivityHeatmap } from '../src/components/ActivityHeatmap'
import { LocalQuestionBank } from '../src/adapters/local-question-bank'
import { LocalRuleAgent } from '../src/adapters/local-rule-agent'
import { StudyService } from '../src/domain/study-service'
import { emptyDraft } from '../src/shared/types'
import type { Attempt } from '../src/shared/types'

function attempt(id: string, submittedAt: string, questionId = 'pol-choice-1'): Attempt {
  return {
    id,
    submittedAt,
    questionId,
    draft: emptyDraft(),
    score: 0,
    maxScore: 4,
    feedback: '',
    explanation: '',
    reviewer: 'local',
    rubric: [],
  }
}

// Give every timezone case its own Node process. This avoids worker-specific TZ
// mutation behavior and proves grouping against actual platform timezone rules.
const modelSource = transformSync(
  readFileSync(new URL('../src/domain/activity.ts', import.meta.url), 'utf8'),
  { loader: 'ts', format: 'cjs' },
).code
function inTimezone(timezone: string, now: string, attempts: Attempt[] = []) {
  const source = `
    const activity = (() => { const module = { exports: {} }; ${modelSource}; return module.exports })();
    const days = activity.buildActivityDays(${JSON.stringify(attempts)}, new Date(${JSON.stringify(now)}));
    process.stdout.write(JSON.stringify(days.map(day => ({ key: day.key, count: day.count, level: day.level, hours: day.date.getHours(), weekday: day.date.getDay(), ids: day.attempts.map(a => a.id) }))));
  `
  const result = spawnSync(process.execPath, ['-e', source], {
    env: { ...process.env, TZ: timezone },
    encoding: 'utf8',
  })
  expect(result.status, result.stderr).toBe(0)
  return JSON.parse(result.stdout) as {
    key: string
    count: number
    level: number
    hours: number
    weekday: number
    ids: string[]
  }[]
}

afterEach(() => vi.useRealTimers())

describe('local submission activity', () => {
  it('builds 26 week columns through today with neutral empty days, without changing now', () => {
    const now = new Date(2026, 9, 10, 13, 0)
    const original = now.getTime()
    const days = buildActivityDays([], now)
    expect(days).toHaveLength(182)
    expect(days[0].date.getDay()).toBe(0)
    expect(days.at(-1)?.key).toBe('2026-10-10')
    expect(
      days.every((day) => day.count === 0 && day.level === 0 && day.attempts.length === 0),
    ).toBe(true)
    expect(new Set(days.map((day) => day.key)).size).toBe(days.length)
    expect(now.getTime()).toBe(original)
  })

  it('counts repeated submissions independently, newest first, regardless of score or subject', () => {
    const now = new Date(2026, 9, 10, 13, 0)
    const older = attempt('a', new Date(2026, 9, 10, 9, 0).toISOString())
    const newer = attempt('b', new Date(2026, 9, 10, 10, 0).toISOString())
    const other = attempt('c', new Date(2026, 9, 10, 11, 0).toISOString(), 'unknown-question')
    const input = [older, newer, other]
    const day = buildActivityDays(input, now).at(-1)!
    expect(day.count).toBe(3)
    expect(day.level).toBe(2)
    expect(day.attempts.map((entry) => entry.id)).toEqual(['c', 'b', 'a'])
    expect(input).toEqual([older, newer, other])
    expect(day.attempts[2]).toBe(older)
  })

  it('ignores invalid, ambiguous, impossible, out-of-window, and future instants including later today', () => {
    const now = new Date('2026-10-10T13:00:00Z')
    const input = [
      'not-a-date',
      '',
      '2026-10-10',
      '2026-10-10T09:00:00',
      '2026-09-31T08:00:00Z',
      '2026-02-29T08:00:00Z',
      '2026-10-10T24:00:00Z',
      '2026-10-10T09:60:00Z',
      '2026-10-10T09:00:00+25:00',
      '2026-10-10T13:00:00.001Z',
      '2026-10-10T23:00:00Z',
      '2026-10-11T00:00:00Z',
      '2025-01-01T00:00:00Z',
    ].map((time, index) => attempt(String(index), time))
    const days = buildActivityDays(input, now)
    expect(days.reduce((total, day) => total + day.count, 0)).toBe(0)
    expect(
      buildActivityDays([attempt('exact-now', now.toISOString())], now).reduce(
        (total, day) => total + day.count,
        0,
      ),
    ).toBe(1)
    expect(buildActivityDays(input, new Date(NaN))).toEqual([])
  })

  it.each([
    [0, 0],
    [1, 1],
    [2, 2],
    [3, 2],
    [4, 3],
    [6, 3],
    [7, 4],
    [1000, 4],
    [-1, 0],
    [NaN, 0],
    [Infinity, 0],
  ])('uses stable count levels: %s maps to %s', (count, expected) => {
    expect(activityIntensity(count)).toBe(expected)
  })

  it('groups UTC instants into local days in positive and negative offset zones', () => {
    const input = [
      attempt('before', '2026-01-01T15:59:59Z'),
      attempt('after', '2026-01-01T16:00:00Z'),
    ]
    const china = inTimezone('Asia/Shanghai', '2026-01-02T10:00:00Z', input)
    expect(china.find((day) => day.key === '2026-01-01')?.ids).toEqual(['before'])
    expect(china.find((day) => day.key === '2026-01-02')?.ids).toEqual(['after'])
    const us = inTimezone('America/Los_Angeles', '2026-01-02T10:00:00Z', [
      attempt('before', '2026-01-02T07:59:59Z'),
      attempt('after', '2026-01-02T08:00:00Z'),
    ])
    expect(us.find((day) => day.key === '2026-01-01')?.ids).toEqual(['before'])
    expect(us.find((day) => day.key === '2026-01-02')?.ids).toEqual(['after'])
  })

  it('iterates every calendar day across spring DST and counts both sides of the missing hour', () => {
    const days = inTimezone('America/New_York', '2026-03-10T18:00:00Z', [
      attempt('before', '2026-03-08T01:59:59-05:00'),
      attempt('after', '2026-03-08T03:00:00-04:00'),
    ])
    expect(days.slice(-4).map((day) => day.key)).toEqual([
      '2026-03-07',
      '2026-03-08',
      '2026-03-09',
      '2026-03-10',
    ])
    expect(days.find((day) => day.key === '2026-03-08')?.count).toBe(2)
    expect(days.every((day) => day.hours === 12)).toBe(true)
    expect(days.every((day, index) => day.weekday === index % 7)).toBe(true)
  })

  it('keeps repeated fall DST hours on one day without duplicate date cells', () => {
    const days = inTimezone('America/New_York', '2026-11-02T18:00:00Z', [
      attempt('first', '2026-11-01T01:30:00-04:00'),
      attempt('second', '2026-11-01T01:30:00-05:00'),
    ])
    expect(days.find((day) => day.key === '2026-11-01')?.ids).toEqual(['second', 'first'])
    expect(new Set(days.map((day) => day.key)).size).toBe(days.length)
    expect(days.every((day, index) => day.weekday === index % 7)).toBe(true)
  })

  it('includes leap day, crosses year boundaries, and gives a new Sunday its own column', () => {
    const leap = inTimezone('Pacific/Auckland', '2024-03-01T01:00:00Z', [
      attempt('leap', '2024-02-29T12:00:00+13:00'),
    ])
    expect(leap.slice(-3).map((day) => day.key)).toEqual(['2024-02-28', '2024-02-29', '2024-03-01'])
    expect(leap.find((day) => day.key === '2024-02-29')?.count).toBe(1)
    const newYear = inTimezone('UTC', '2027-01-01T12:00:00Z')
    expect(newYear.slice(-2).map((day) => day.key)).toEqual(['2026-12-31', '2027-01-01'])
    const sunday = inTimezone('UTC', '2026-10-11T00:00:00Z')
    expect(sunday).toHaveLength(176)
    expect(sunday.at(-1)?.key).toBe('2026-10-11')
    expect(sunday.at(-1)?.weekday).toBe(0)
  })

  it('derives activity from persisted submissions after reload; drafts and failed submissions add nothing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'examcraft-activity-'))
    try {
      const service = new StudyService(
        directory,
        new LocalQuestionBank(directory),
        new LocalRuleAgent(),
      )
      await service.saveDraft('pol-choice-1', { ...emptyDraft(), choiceId: 'A' })
      await expect(service.submitAnswer('pol-choice-1', emptyDraft())).rejects.toThrow()
      expect(
        buildActivityDays((await service.loadState()).attempts, new Date()).every(
          (day) => day.count === 0,
        ),
      ).toBe(true)
      await service.submitAnswer('pol-choice-1', { ...emptyDraft(), choiceId: 'A' })
      await service.submitAnswer('pol-choice-1', { ...emptyDraft(), choiceId: 'B' })
      const reopened = new StudyService(
        directory,
        new LocalQuestionBank(directory),
        new LocalRuleAgent(),
      )
      const days = buildActivityDays((await reopened.loadState()).attempts, new Date())
      expect(days.reduce((total, day) => total + day.count, 0)).toBe(2)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('renders descriptive day buttons, a count legend and unknown-question history fallback', () => {
    const now = new Date(2026, 9, 10, 13)
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const html = renderToStaticMarkup(
      createElement(ActivityHeatmap, {
        attempts: [attempt('missing-question', now.toISOString(), 'removed-question')],
        questions: [],
        onSelectAttempt: () => {},
      }),
    )
    expect(html).toContain(
      `data-testid="activity-day-${localActivityKey(now)}" data-count="1" data-level="1"`,
    )
    expect(html).toContain('aria-label="颜色图例：每天的提交次数"')
    expect(html).toContain('data-testid="activity-day-details"')
    expect(html).toContain('data-testid="activity-attempt-missing-question"')
    expect(html).toContain('未找到题目（removed-question）')
    expect(html).toContain('1 次提交，今天')
    expect(html).toContain('tabindex="0"')
  })
})
