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
  if (typeof lang !== 'string' || !LANGS.has(lang)) {
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

export function summarizeRoutingAgreement(leftLabels, rightLabels) {
  const rightByCase = new Map(rightLabels.map((label) => [label.caseId, label]))
  const pairs = []
  for (const left of leftLabels) {
    const right = rightByCase.get(left.caseId)
    if (right === undefined) continue
    if (left.lang !== right.lang) {
      throw new Error(`language mismatch for ${left.caseId}: ${left.lang} vs ${right.lang}`)
    }
    pairs.push({ caseId: left.caseId, lang: left.lang, agree: labelsAgree(left, right) })
  }

  const summary = { n: pairs.length, exact: 0, exactRate: 0, byLang: {} }
  for (const pair of pairs) {
    const lang = pair.lang
    summary.byLang[lang] ??= { n: 0, exact: 0, exactRate: 0 }
    summary.byLang[lang].n += 1
    if (pair.agree) {
      summary.exact += 1
      summary.byLang[lang].exact += 1
    }
  }
  summary.exactRate = summary.n === 0 ? 0 : summary.exact / summary.n
  for (const entry of Object.values(summary.byLang)) {
    entry.exactRate = entry.n === 0 ? 0 : entry.exact / entry.n
  }

  const unmatched = [
    ...leftLabels.filter((label) => !rightByCase.has(label.caseId)).map((label) => label.caseId),
    ...rightLabels
      .filter((label) => !leftLabels.some((left) => left.caseId === label.caseId))
      .map((label) => label.caseId),
  ].sort()

  return { ...summary, unmatched }
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
