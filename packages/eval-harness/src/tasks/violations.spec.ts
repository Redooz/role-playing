import { describe, expect, it } from 'vitest'
import { formatViolation, pushSchemaViolations, renderFieldPath } from './violations.js'
import type { TaskViolation } from './violations.js'

describe('formatViolation', () => {
  it('renders path, code and message in the CLI contract form', () => {
    expect(
      formatViolation({
        path: 'evals/tasks/ds/v1/en/a.json',
        code: 'INVALID_JSON',
        message: 'invalid JSON: Unexpected end of JSON input',
      }),
    ).toBe('evals/tasks/ds/v1/en/a.json: [INVALID_JSON] invalid JSON: Unexpected end of JSON input')
  })

  it('keeps the raw message untouched, including punctuation', () => {
    expect(formatViolation({ path: 'evals', code: 'EVALS_DIR_MISSING', message: 'a: b [c]' })).toBe(
      'evals: [EVALS_DIR_MISSING] a: b [c]',
    )
  })
})

describe('renderFieldPath', () => {
  it.each([
    [[], '<root>'],
    [['cefrBand'], 'cefrBand'],
    [['content', 'turns', 0], 'content.turns[0]'],
    [['content', 'turns', 0, 'text'], 'content.turns[0].text'],
    [[0], '[0]'],
    [[0, 'text'], '[0].text'],
    [[2, 3], '[2][3]'],
    [['a'], 'a'],
  ] as const)('renders %j as %j', (path, expected) => {
    expect(renderFieldPath(path)).toBe(expected)
  })

  it('renders a symbol segment through String()', () => {
    expect(renderFieldPath([Symbol('tag')])).toBe('Symbol(tag)')
  })
})

describe('pushSchemaViolations', () => {
  it('pushes one SCHEMA_VIOLATION per issue with the rendered field', () => {
    const violations: TaskViolation[] = []

    pushSchemaViolations(violations, 'evals/tasks/ds/v1/en/a.json', [
      { path: ['cefrBand'], message: 'Invalid option' },
      { path: ['content', 'turns', 1, 'role'], message: 'Invalid input' },
      { path: [], message: 'Invalid input: expected object, received null' },
    ])

    expect(violations).toStrictEqual([
      {
        path: 'evals/tasks/ds/v1/en/a.json',
        code: 'SCHEMA_VIOLATION',
        message: 'cefrBand: Invalid option',
      },
      {
        path: 'evals/tasks/ds/v1/en/a.json',
        code: 'SCHEMA_VIOLATION',
        message: 'content.turns[1].role: Invalid input',
      },
      {
        path: 'evals/tasks/ds/v1/en/a.json',
        code: 'SCHEMA_VIOLATION',
        message: '<root>: Invalid input: expected object, received null',
      },
    ])
  })

  it('appends to the existing list without dropping earlier violations', () => {
    const existing: TaskViolation = {
      path: 'evals/golden/en/v1/a.json',
      code: 'GOLDEN_AGREEMENT_MISSING',
      message: 'stable needs agreement',
    }
    const violations: TaskViolation[] = [existing]

    pushSchemaViolations(violations, 'evals/golden/en/v1/a.json', [
      { path: ['status'], message: 'Invalid option' },
    ])

    expect(violations).toStrictEqual([
      existing,
      {
        path: 'evals/golden/en/v1/a.json',
        code: 'SCHEMA_VIOLATION',
        message: 'status: Invalid option',
      },
    ])
  })

  it('pushes nothing for an empty issue list', () => {
    const violations: TaskViolation[] = []
    pushSchemaViolations(violations, 'evals/tasks/ds/v1/en/a.json', [])
    expect(violations).toStrictEqual([])
  })
})
