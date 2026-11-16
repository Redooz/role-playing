/**
 * Pure routing-label helpers for the annotation kit (M3a D3).
 *
 * These functions never call a model and never read eval scores. They validate
 * one annotator's acceptable-outcome label and compare two independent passes.
 */

const LANGS = new Set(['en', 'fr'])

export function parseRoutingLabel(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('routing label must be a JSON object')
  }
  const caseId = raw.caseId
  const intent = raw.intent
  const acceptablePersonaIds = raw.acceptablePersonaIds
  const allowUserYield = raw.allowUserYield
  const lang = raw.lang

  if (typeof caseId !== 'string' || caseId.length === 0) {
    throw new Error('caseId must be a non-empty string')
  }
  if (typeof intent !== 'string' || intent.trim().length === 0) {
    throw new Error('intent must be a non-empty string')
  }
  if (
    !Array.isArray(acceptablePersonaIds) ||
    acceptablePersonaIds.some((id) => typeof id !== 'string' || id.length === 0)
  ) {
    throw new Error('acceptablePersonaIds must be an array of non-empty strings')
  }
  if (new Set(acceptablePersonaIds).size !== acceptablePersonaIds.length) {
    throw new Error('acceptablePersonaIds must not repeat')
  }
  if (typeof allowUserYield !== 'boolean') {
    throw new Error('allowUserYield must be a boolean')
  }
  if (acceptablePersonaIds.length === 0 && !allowUserYield) {
    throw new Error('a label must accept at least one persona or learner yield')
  }
  if (!LANGS.has(lang)) {
    throw new Error('lang must be "en" or "fr"')
  }

  return {
    caseId,
    lang,
    intent,
    acceptablePersonaIds: [...acceptablePersonaIds],
    allowUserYield,
  }
}

/** Stable set signature; `yield` is part of the accepted outcome set. */
export function outcomeSignature(label) {
  const parts = [...label.acceptablePersonaIds].sort()
  if (label.allowUserYield) parts.push('yield')
  return parts.join('|')
}

export function labelsAgree(left, right) {
  return outcomeSignature(left) === outcomeSignature(right)
}

/** The three label classes, in report order. */
export const ROUTING_CLASSES = ['speak', 'silence', 'mixed']

/** Classify one label by who is allowed to speak. */
export function routingLabelClass(label) {
  if (label.acceptablePersonaIds.length === 0) return 'silence'
  return label.allowUserYield ? 'mixed' : 'speak'
}

/**
 * Compare two independent passes.
 *
 * Pass `{ classByCase }` (a `Map` or plain object from an operator manifest) to
 * add per-class agreement and the two directional disagreement counts. Without
 * it the summary is exactly the per-language shape older callers expect.
 */
function classLookup(options) {
  const value = options.classByCase
  if (value === undefined) return undefined
  return value instanceof Map ? value : new Map(Object.entries(value))
}

function emptyCounts() {
  return { n: 0, exact: 0, exactRate: 0 }
}

/** Add one pair to a counter. The caller only passes counted pairs, so n >= 1. */
function addCount(counts, agree) {
  counts.n += 1
  if (agree) counts.exact += 1
  counts.exactRate = counts.exact / counts.n
}

/** The directional name of a silence/speaker disagreement, if it is one. */
function directionOf(leftClass, rightClass) {
  if (leftClass === 'silence' && rightClass === 'speak') return 'aSilenceBSpoke'
  if (leftClass === 'speak' && rightClass === 'silence') return 'aSpokeBSilence'
  return undefined
}

export function summarizeRoutingAgreement(leftLabels, rightLabels, options = {}) {
  const rightByCase = new Map(rightLabels.map((label) => [label.caseId, label]))
  const classes = classLookup(options)
  const pairs = []
  for (const left of leftLabels) {
    const right = rightByCase.get(left.caseId)
    if (right === undefined) continue
    if (left.lang !== right.lang) {
      throw new Error(`language mismatch for ${left.caseId}: ${left.lang} vs ${right.lang}`)
    }
    const expectedClass = classes?.get(left.caseId)
    if (classes !== undefined && expectedClass === undefined) {
      throw new Error(`missing expected class for ${left.caseId}`)
    }
    pairs.push({
      caseId: left.caseId,
      lang: left.lang,
      agree: labelsAgree(left, right),
      leftClass: routingLabelClass(left),
      rightClass: routingLabelClass(right),
      expectedClass,
    })
  }

  const summary = { n: pairs.length, exact: 0, exactRate: 0, byLang: {} }
  for (const pair of pairs) {
    summary.byLang[pair.lang] ??= emptyCounts()
    addCount(summary.byLang[pair.lang], pair.agree)
  }
  summary.exact = pairs.filter((pair) => pair.agree).length
  summary.exactRate = summary.n === 0 ? 0 : summary.exact / summary.n

  const unmatched = [
    ...leftLabels.filter((label) => !rightByCase.has(label.caseId)).map((label) => label.caseId),
    ...rightLabels
      .filter((label) => !leftLabels.some((left) => left.caseId === label.caseId))
      .map((label) => label.caseId),
  ].sort()

  if (classes === undefined) return { ...summary, unmatched }

  const classValues = new Set(classes.values())
  for (const klass of classValues) {
    if (!ROUTING_CLASSES.includes(klass)) {
      throw new Error(`unknown expected class "${klass}"`)
    }
  }
  const declaredClasses = ROUTING_CLASSES.filter((klass) => classValues.has(klass))
  const byClass = {}
  for (const klass of declaredClasses) byClass[klass] = emptyCounts()
  const byClassAndLang = {}
  const directions = { aSilenceBSpoke: 0, aSpokeBSilence: 0 }
  for (const pair of pairs) {
    byClassAndLang[pair.lang] ??= {}
    for (const klass of declaredClasses) {
      byClassAndLang[pair.lang][klass] ??= emptyCounts()
    }
    addCount(byClass[pair.expectedClass], pair.agree)
    addCount(byClassAndLang[pair.lang][pair.expectedClass], pair.agree)
    const direction = directionOf(pair.leftClass, pair.rightClass)
    if (direction !== undefined) directions[direction] += 1
  }

  return { ...summary, byClass, byClassAndLang, directions, unmatched }
}

/** Return every language below the pre-registered exact-agreement bar. */
export function agreementFailures(summary, minimum) {
  const failures = []
  for (const [lang, entry] of Object.entries(summary.byLang)) {
    if (entry.n === 0) failures.push(`${lang}: no matched cases`)
    else if (entry.exactRate < minimum) {
      failures.push(`${lang}: ${entry.exactRate.toFixed(3)} < ${minimum.toFixed(3)}`)
    }
  }
  return failures
}

/** Return every class below the pre-registered exact-agreement bar. */
export function agreementFailuresByClass(summary, minimum) {
  const failures = []
  if (summary.byClass === undefined) return failures
  for (const [klass, entry] of Object.entries(summary.byClass)) {
    if (entry.n === 0) failures.push(`${klass}: no matched cases`)
    else if (entry.exactRate < minimum) {
      failures.push(`${klass}: ${entry.exactRate.toFixed(3)} < ${minimum.toFixed(3)}`)
    }
  }
  return failures
}

/** Return every language × class cell below the pre-registered bar. */
export function agreementFailuresByClassAndLanguage(summary, minimum) {
  const failures = []
  if (summary.byClassAndLang === undefined) return failures
  for (const [lang, perClass] of Object.entries(summary.byClassAndLang)) {
    for (const [klass, entry] of Object.entries(perClass)) {
      if (entry.n === 0) failures.push(`${lang}/${klass}: no matched cases`)
      else if (entry.exactRate < minimum) {
        failures.push(`${lang}/${klass}: ${entry.exactRate.toFixed(3)} < ${minimum.toFixed(3)}`)
      }
    }
  }
  return failures
}

/** Strip operator-only metadata before an annotator sees a case. */
export function annotatorCase(task, caseId) {
  if (task === null || typeof task !== 'object' || task.mode !== 'routing') {
    throw new Error('only a routing task can become an annotator case')
  }
  if (typeof caseId !== 'string' || caseId.length === 0) {
    throw new Error('an annotator case needs an opaque caseId')
  }
  const context = task.routing?.context
  if (context === undefined) throw new Error('routing task has no context')

  return {
    caseId,
    lang: task.lang,
    cefrBand: task.cefrBand,
    scenarioType: task.scenarioType,
    scenarioBrief: task.content?.scenarioBrief ?? '',
    transcript: context.transcript,
    personas: context.personas,
    coveredObjectiveIds: context.coveredObjectiveIds,
  }
}
