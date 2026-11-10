import {
  JEV_DEFAULT_TIMEOUT_MS,
  JEV_ENDPOINT,
  JEV_MODEL,
  JEV_PROVIDER_SURFACE,
} from './constants.js'
import { computeJevCacheKey, createFileJevCache, defaultJevCacheDir } from './cache.js'
import type { JevCache } from './cache.js'
import { JevConfigError, JevError, JevInvalidResponseError, JevUnavailableError } from './errors.js'
import { parseJevAnswersForQuestions } from './response.js'
import { formatZodIssues, jevBatchJudgmentSchema, jevJudgmentSchema } from './schemas.js'
import type {
  JevBatchFailure,
  JevBatchJudgment,
  JevBatchResult,
  JevBatchSuccess,
  JevCacheStatus,
  JevGrader,
  JevJudgment,
  JevJudgmentFailure,
  JevQuestionSet,
  JevRequestPayload,
  JevResult,
} from './types.js'

export interface JevClientOptions {
  /** Loaded from the environment at runtime; never written to a file or a log. */
  readonly apiKey: string
  readonly fetchImpl?: typeof fetch
  /**
   * Exists only to fail loudly on misconfiguration. The sole accepted value is
   * `typesafe/jev-1.14`; `jev-latest` and per-call overrides are rejected.
   */
  readonly model?: string
  /** Inject a cache implementation, or pass `false` to disable caching. */
  readonly cache?: JevCache | false
  /** Directory for the built-in file cache. Ignored when `cache` is provided. */
  readonly cacheDir?: string
  readonly providerSurface?: string
  readonly timeoutMs?: number
}

export interface JevClient extends JevGrader {
  readonly model: typeof JEV_MODEL
  readonly providerSurface: string
  /** Content-addressed key for a valid judgment; useful for tests and audit logs. */
  cacheKeyFor(judgment: JevJudgment): string
  /** Ask several independent questions against one shared state in one call. */
  decideMany(judgment: JevBatchJudgment): Promise<JevBatchResult>
}

/**
 * Create a Decisions API client pinned to `typesafe/jev-1.14`.
 *
 * Every call carries exactly one atomic judgment and returns the full raw
 * response plus a probability distribution. Operational failures are returned
 * as `{ ok: false, error }`; they never become a label, probability, zero, or
 * pass. The constructor throws `JevConfigError` for an invalid pin or config.
 */
export function createJevClient(options: JevClientOptions): JevClient {
  const apiKey = options.apiKey.trim()
  if (apiKey === '') {
    throw new JevConfigError('A non-empty OpenRouter API key is required.')
  }

  if (options.model !== undefined && options.model !== JEV_MODEL) {
    throw new JevConfigError(
      `Jev is pinned to ${JEV_MODEL}; refusing configured model ${JSON.stringify(options.model)}.`,
    )
  }

  const providerSurface = options.providerSurface ?? JEV_PROVIDER_SURFACE
  if (providerSurface.trim() === '') {
    throw new JevConfigError('The Jev provider surface must be non-empty.')
  }

  const timeoutMs = options.timeoutMs ?? JEV_DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new JevConfigError(`Jev timeout must be a positive number of milliseconds.`)
  }

  const fetchImpl = options.fetchImpl ?? fetch
  const cache =
    options.cache === false
      ? undefined
      : (options.cache ??
        createFileJevCache({ directory: options.cacheDir ?? defaultJevCacheDir() }))

  function buildRequest(
    state: JevBatchJudgment['state'],
    questions: JevQuestionSet,
  ): JevRequestPayload {
    return { model: JEV_MODEL, state, questions }
  }

  function cacheKeyForBatch(judgment: JevBatchJudgment): string {
    return computeJevCacheKey({
      request: buildRequest(judgment.state, judgment.questions),
      graderVersion: judgment.metadata.graderVersion,
      rubricVersion: judgment.metadata.rubricVersion,
      extractionVersion: judgment.metadata.extractionVersion,
      providerSurface,
      ...(judgment.metadata.locale === undefined ? {} : { locale: judgment.metadata.locale }),
    })
  }

  function cacheKeyFor(judgment: JevJudgment): string {
    return cacheKeyForBatch({
      metadata: judgment.metadata,
      state: judgment.state,
      questions: { [judgment.metadata.id]: judgment.question },
    })
  }

  function safeCacheKeyFor(judgment: JevBatchJudgment): CacheKeyResult {
    try {
      return { ok: true, key: cacheKeyForBatch(judgment) }
    } catch (error) {
      return {
        ok: false,
        error: new JevConfigError('Could not compute the Jev cache key.', { cause: error }),
      }
    }
  }

  async function execute(judgment: JevBatchJudgment): Promise<JevBatchResult> {
    const questionIds = Object.keys(judgment.questions)
    const request = buildRequest(judgment.state, judgment.questions)

    const cacheKeyResult = safeCacheKeyFor(judgment)
    if (!cacheKeyResult.ok) {
      return batchFailure(questionIds, cacheKeyResult.error, null)
    }
    const cacheKey = cacheKeyResult.key

    if (cache !== undefined) {
      try {
        const cachedRaw = await cache.read(cacheKey)
        if (cachedRaw !== undefined) {
          try {
            const parsedAnswer = parseJevAnswersForQuestions(cachedRaw, judgment.questions)
            return batchSuccess(judgment, request, parsedAnswer, cachedRaw, {
              key: cacheKey,
              hit: true,
              stored: false,
            })
          } catch {
            // A corrupt or stale entry is a miss, not a judgment and not a failure.
          }
        }
      } catch {
        // The cache is best-effort; a cache problem must not change the verdict.
      }
    }

    const serializedRequest = serializeRequest(request)
    if (!serializedRequest.ok) {
      return batchFailure(questionIds, serializedRequest.error, cacheKey)
    }
    const body = serializedRequest.body

    const fetchResult = await fetchDecision(fetchImpl, apiKey, body, timeoutMs)
    if (!fetchResult.ok) {
      return batchFailure(questionIds, fetchResult.error, cacheKey)
    }
    const httpResponse = fetchResult.response

    if (!httpResponse.ok) {
      const detail = await readResponseDetail(httpResponse)
      return batchFailure(
        questionIds,
        new JevUnavailableError(
          `Jev request failed with HTTP ${httpResponse.status}${detail === '' ? '' : `: ${detail}`}`,
          { reason: 'http', status: httpResponse.status },
        ),
        cacheKey,
      )
    }

    const responseBody = await readResponseBody(httpResponse)
    if (!responseBody.ok) {
      return batchFailure(questionIds, responseBody.error, cacheKey)
    }

    const jsonResult = parseResponseJson(responseBody.text)
    if (!jsonResult.ok) {
      return batchFailure(questionIds, jsonResult.error, cacheKey)
    }
    const raw = jsonResult.raw

    const answerResult = parseBatchAnswer(raw, judgment)
    if (!answerResult.ok) {
      return batchFailure(questionIds, answerResult.error, cacheKey)
    }
    const parsedAnswer = answerResult.answer

    let stored = false
    if (cache !== undefined) {
      try {
        await cache.write(cacheKey, raw)
        stored = true
      } catch {
        // A failed cache write does not invalidate a successful judgment.
      }
    }

    return batchSuccess(judgment, request, parsedAnswer, raw, {
      key: cacheKey,
      hit: false,
      stored,
    })
  }

  async function decideMany(input: JevBatchJudgment): Promise<JevBatchResult> {
    const questionIds = questionIdsOfBatch(input)

    if (input !== null && typeof input === 'object' && Object.hasOwn(input, 'model')) {
      return batchFailure(
        questionIds,
        new JevConfigError(
          `Jev model is fixed at ${JEV_MODEL}; per-call model overrides are not accepted.`,
        ),
        null,
      )
    }

    const parsedJudgment = jevBatchJudgmentSchema.safeParse(input)
    if (!parsedJudgment.success) {
      return batchFailure(
        questionIds,
        new JevConfigError('Invalid batched Jev judgment.', {
          details: formatZodIssues(parsedJudgment.error),
        }),
        null,
      )
    }

    return execute(parsedJudgment.data)
  }

  async function grade(input: JevJudgment): Promise<JevResult> {
    const questionId = questionIdOf(input)

    if (input !== null && typeof input === 'object' && Object.hasOwn(input, 'model')) {
      return failure(
        questionId,
        new JevConfigError(
          `Jev model is fixed at ${JEV_MODEL}; per-call model overrides are not accepted.`,
        ),
        null,
      )
    }

    const parsedJudgment = jevJudgmentSchema.safeParse(input)
    if (!parsedJudgment.success) {
      return failure(
        questionId,
        new JevConfigError('Invalid Jev judgment.', {
          details: formatZodIssues(parsedJudgment.error),
        }),
        null,
      )
    }
    const judgment: JevJudgment = parsedJudgment.data

    const result = await execute({
      metadata: judgment.metadata,
      state: judgment.state,
      questions: { [judgment.metadata.id]: judgment.question },
    })
    if (!result.ok) return failure(questionId, result.error, result.cache.key)

    const distribution = result.distributions[judgment.metadata.id]
    if (distribution === undefined) {
      return failure(
        questionId,
        new JevInvalidResponseError('Jev returned no distribution for the question.'),
        result.cache.key,
      )
    }

    return {
      ok: true,
      questionId,
      request: result.request,
      response: result.response,
      raw: result.raw,
      distribution,
      usage: result.usage,
      servedModel: result.servedModel,
      cache: result.cache,
    }
  }

  return {
    model: JEV_MODEL,
    providerSurface,
    grade,
    decideMany,
    cacheKeyFor,
  }
}

function batchSuccess(
  judgment: JevBatchJudgment,
  request: JevRequestPayload,
  parsedAnswer: ReturnType<typeof parseJevAnswersForQuestions>,
  raw: unknown,
  cache: JevCacheStatus,
): JevBatchSuccess {
  return {
    ok: true,
    questionIds: Object.keys(judgment.questions),
    request,
    response: parsedAnswer.response,
    raw,
    answers: parsedAnswer.answers,
    distributions: parsedAnswer.distributions,
    usage: parsedAnswer.response.usage,
    servedModel: parsedAnswer.response.model,
    cache,
  }
}

function batchFailure(
  questionIds: readonly string[],
  error: JevError,
  cacheKey: string | null,
): JevBatchFailure {
  return {
    ok: false,
    questionIds,
    error,
    cache: { key: cacheKey, hit: false, stored: false },
  }
}

function failure(questionId: string, error: JevError, cacheKey: string | null): JevJudgmentFailure {
  return {
    ok: false,
    questionId,
    error,
    cache: { key: cacheKey, hit: false, stored: false },
  }
}

function questionIdOf(judgment: JevJudgment): string {
  const metadata: unknown = judgment?.metadata
  if (typeof metadata === 'object' && metadata !== null && 'id' in metadata) {
    const id = metadata.id
    return typeof id === 'string' ? id : ''
  }
  return ''
}

function questionIdsOfBatch(judgment: JevBatchJudgment): readonly string[] {
  const questions: unknown = judgment?.questions
  if (typeof questions !== 'object' || questions === null) return []
  return Object.keys(questions)
}

function unavailableFromException(error: unknown): JevUnavailableError {
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return new JevUnavailableError('Jev request timed out before a response arrived.', {
      reason: 'timeout',
      cause: error,
    })
  }

  const detail = error instanceof Error ? `: ${error.message}` : ''
  return new JevUnavailableError(`Jev request failed before a response arrived${detail}`, {
    reason: 'network',
    cause: error,
  })
}

function asTypedError(error: unknown): JevError {
  if (error instanceof JevError) return error
  return new JevInvalidResponseError('Could not validate the Jev response.', { cause: error })
}

type CacheKeyResult =
  | { readonly ok: true; readonly key: string }
  | { readonly ok: false; readonly error: JevConfigError }

type SerializeRequestResult =
  | { readonly ok: true; readonly body: string }
  | { readonly ok: false; readonly error: JevConfigError }

function serializeRequest(request: JevRequestPayload): SerializeRequestResult {
  try {
    return { ok: true, body: JSON.stringify(request) }
  } catch (error) {
    return {
      ok: false,
      error: new JevConfigError('The Jev request is not JSON-serializable.', { cause: error }),
    }
  }
}

type FetchDecisionResult =
  | { readonly ok: true; readonly response: Response }
  | { readonly ok: false; readonly error: JevUnavailableError }

async function fetchDecision(
  fetchImpl: typeof fetch,
  apiKey: string,
  body: string,
  timeoutMs: number,
): Promise<FetchDecisionResult> {
  try {
    const response = await fetchImpl(JEV_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    })
    return { ok: true, response }
  } catch (error) {
    return { ok: false, error: unavailableFromException(error) }
  }
}

type ReadResponseBodyResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: JevUnavailableError }

async function readResponseBody(response: Response): Promise<ReadResponseBodyResult> {
  try {
    return { ok: true, text: await response.text() }
  } catch (error) {
    return {
      ok: false,
      error: new JevUnavailableError('Could not read the Jev response body.', {
        reason: 'network',
        cause: error,
      }),
    }
  }
}

type ParseResponseJsonResult =
  | { readonly ok: true; readonly raw: unknown }
  | { readonly ok: false; readonly error: JevInvalidResponseError }

function parseResponseJson(text: string): ParseResponseJsonResult {
  try {
    return { ok: true, raw: JSON.parse(text) }
  } catch (error) {
    return {
      ok: false,
      error: new JevInvalidResponseError('Jev response was not valid JSON.', {
        cause: error,
        details: [`body length: ${text.length}`],
      }),
    }
  }
}

type ParseAnswerResult =
  | { readonly ok: true; readonly answer: ReturnType<typeof parseJevAnswersForQuestions> }
  | { readonly ok: false; readonly error: JevError }

function parseBatchAnswer(raw: unknown, judgment: JevBatchJudgment): ParseAnswerResult {
  try {
    return {
      ok: true,
      answer: parseJevAnswersForQuestions(raw, judgment.questions),
    }
  } catch (error) {
    return { ok: false, error: asTypedError(error) }
  }
}

async function readResponseDetail(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim()
    if (text === '') return ''
    return text.length > 300 ? `${text.slice(0, 300)}…` : text
  } catch {
    return ''
  }
}
