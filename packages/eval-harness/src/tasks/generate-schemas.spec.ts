import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SCHEMA_FILES,
  expectedSchemas,
  schemaFileContents,
  writeSchemaFiles,
} from './generate-schemas.js'
import { goldenEntrySchema, taskEntrySchema } from './schema.js'

const tempDirs: string[] = []

async function makeTempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'rp-schemas-'))
  tempDirs.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('SCHEMA_FILES', () => {
  it('maps the two committed file names to their Zod schemas', () => {
    expect(Object.keys(SCHEMA_FILES)).toStrictEqual(['task.schema.json', 'golden.schema.json'])
    expect(SCHEMA_FILES['task.schema.json']).toBe(taskEntrySchema)
    expect(SCHEMA_FILES['golden.schema.json']).toBe(goldenEntrySchema)
  })
})

describe('expectedSchemas', () => {
  it('returns one JSON schema per file, keyed by file name', () => {
    const schemas = expectedSchemas()

    expect(Object.keys(schemas)).toStrictEqual(['task.schema.json', 'golden.schema.json'])
    expect(schemas).toStrictEqual({
      'task.schema.json': z.toJSONSchema(taskEntrySchema),
      'golden.schema.json': z.toJSONSchema(goldenEntrySchema),
    })
  })

  it('describes the task entry structure rather than a placeholder', () => {
    const taskSchema = expectedSchemas()['task.schema.json'] as {
      type?: unknown
      properties?: Record<string, unknown>
      required?: readonly string[]
    }

    expect(taskSchema.type).toBe('object')
    expect(Object.keys(taskSchema.properties ?? {})).toEqual(
      expect.arrayContaining(['id', 'lang', 'split', 'provenance', 'content']),
    )
    expect(taskSchema.required).toEqual(expect.arrayContaining(['id', 'lang', 'mode', 'content']))
  })

  it('distinguishes the golden schema from the task schema', () => {
    const schemas = expectedSchemas()

    expect(schemas['golden.schema.json']).not.toStrictEqual(schemas['task.schema.json'])
    expect(Object.keys(schemas['golden.schema.json'] as object)).toEqual(
      expect.arrayContaining(['properties', 'required']),
    )
  })
})

describe('schemaFileContents', () => {
  it('serializes each schema as two-space JSON with a trailing newline', () => {
    const contents = schemaFileContents()
    const schemas = expectedSchemas()

    expect(Object.keys(contents)).toStrictEqual(['task.schema.json', 'golden.schema.json'])
    for (const fileName of Object.keys(schemas)) {
      const text = contents[fileName]
      expect(text).toBe(`${JSON.stringify(schemas[fileName], null, 2)}\n`)
      expect(text?.endsWith('}\n')).toBe(true)
      expect(text).toContain('\n  "')
      expect(JSON.parse(text ?? 'null')).toStrictEqual(schemas[fileName])
    }
  })
})

describe('writeSchemaFiles', () => {
  it('writes every schema into a nested target directory and returns the absolute paths', async () => {
    const root = await makeTempDir()
    const targetDir = join(root, 'nested', 'schemas')

    const written = await writeSchemaFiles(targetDir)

    expect(written).toStrictEqual([
      join(targetDir, 'task.schema.json'),
      join(targetDir, 'golden.schema.json'),
    ])
    const contents = schemaFileContents()
    for (const fileName of Object.keys(contents)) {
      expect(await readFile(join(targetDir, fileName), 'utf8')).toBe(contents[fileName])
    }
    expect(JSON.parse(await readFile(written[0] ?? '', 'utf8'))).toStrictEqual(
      expectedSchemas()['task.schema.json'],
    )
  })

  it('overwrites an existing target directory without failing', async () => {
    const root = await makeTempDir()

    const first = await writeSchemaFiles(root)
    const second = await writeSchemaFiles(root)

    expect(second).toStrictEqual(first)
    expect(JSON.parse(await readFile(join(root, 'golden.schema.json'), 'utf8'))).toStrictEqual(
      expectedSchemas()['golden.schema.json'],
    )
  })
})
