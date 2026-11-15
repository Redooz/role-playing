import { describe, expect, it } from 'vitest'
import { isLang, parseGoldenLocation, parseTaskLocation, relativeToEvals } from './layout.js'

describe('parseTaskLocation', () => {
  it('parses a task path into dataset, version, language and scope', () => {
    expect(parseTaskLocation('tasks/synthetic-workplace/v1/en/task-001.json')).toStrictEqual({
      dataset: 'synthetic-workplace',
      version: 'v1',
      lang: 'en',
      scope: 'synthetic-workplace/v1/en',
    })
  })

  it('accepts a French path and a nested file below the language directory', () => {
    expect(parseTaskLocation('tasks/workplace/v2/fr/batch/deep/task.json')).toStrictEqual({
      dataset: 'workplace',
      version: 'v2',
      lang: 'fr',
      scope: 'workplace/v2/fr',
    })
  })

  it('accepts a trailing slash after the language segment as a nested location', () => {
    expect(parseTaskLocation('tasks/ds/v1/en/')).toStrictEqual({
      dataset: 'ds',
      version: 'v1',
      lang: 'en',
      scope: 'ds/v1/en',
    })
  })

  it.each([
    ['wrong kind', 'golden/en/v1/file.json'],
    ['wrong kind with a parseable remainder', 'golden/ds/v1/en/file.json'],
    ['missing kind', 'ds/v1/en/file.json'],
    ['empty dataset', 'tasks//v1/en/file.json'],
    ['missing dataset', 'tasks'],
    ['empty version', 'tasks/ds//en/file.json'],
    ['missing version', 'tasks/ds/en'],
    ['invalid language', 'tasks/ds/v1/de/file.json'],
    ['locale instead of language', 'tasks/ds/v1/en-GB/file.json'],
    ['no file below the language', 'tasks/ds/v1/en'],
    ['empty path', ''],
  ])('rejects %s', (_label, path) => {
    expect(parseTaskLocation(path)).toBeUndefined()
  })
})

describe('parseGoldenLocation', () => {
  it('parses a golden path into version, language and scope', () => {
    expect(parseGoldenLocation('golden/fr/v2/entry.json')).toStrictEqual({
      version: 'v2',
      lang: 'fr',
      scope: 'fr/v2',
    })
  })

  it('accepts a nested file below the version directory', () => {
    expect(parseGoldenLocation('golden/en/v1/batch/entry.json')).toStrictEqual({
      version: 'v1',
      lang: 'en',
      scope: 'en/v1',
    })
  })

  it('accepts a trailing slash after the version segment as a nested location', () => {
    expect(parseGoldenLocation('golden/en/v1/')).toStrictEqual({
      version: 'v1',
      lang: 'en',
      scope: 'en/v1',
    })
  })

  it.each([
    ['wrong kind', 'tasks/ds/v1/en/file.json'],
    ['wrong kind with a parseable remainder', 'tasks/en/v1/file.json'],
    ['missing kind', 'en/v1/file.json'],
    ['invalid language', 'golden/de/v1/file.json'],
    ['locale instead of language', 'golden/en-GB/v1/file.json'],
    ['empty version', 'golden/en//file.json'],
    ['missing version', 'golden/en'],
    ['no file below the version', 'golden/en/v1'],
    ['empty path', ''],
  ])('rejects %s', (_label, path) => {
    expect(parseGoldenLocation(path)).toBeUndefined()
  })
})

describe('relativeToEvals', () => {
  it.each([
    ['evals/tasks/ds/v1/en/a.json', 'tasks/ds/v1/en/a.json'],
    ['evals/golden/en/v1/a.json', 'golden/en/v1/a.json'],
    ['evals', ''],
    ['', ''],
    ['a/b/c', 'b/c'],
  ])('turns %j into %j', (displayPath, expected) => {
    expect(relativeToEvals(displayPath)).toBe(expected)
  })
})

describe('isLang', () => {
  it.each([
    ['en', true],
    ['fr', true],
    ['de', false],
    ['en-GB', false],
    ['EN', false],
    ['', false],
  ])('treats %j as a language: %s', (value, expected) => {
    expect(isLang(value)).toBe(expected)
  })
})
