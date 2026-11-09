/**
 * `pass^1` and `pass^k` (M2 D9).
 *
 * `pass^k` is the probability that *every one* of k independent trials of the
 * same task succeeds, estimated per task as `C(c, k) / C(n, k)` and averaged
 * over tasks. It is reported with `pass^1`, never alone: a low `pass^k` with a
 * healthy `pass^1` is a variance finding.
 */

export interface PassTrial {
  readonly round: number
  readonly taskId: string
  readonly lang: string
  /** Binary per-trial outcome. There is no Likert scale. */
  readonly passed: boolean
}

export interface TaskPassMetric {
  readonly lang: string
  readonly taskId: string
  readonly trials: number
  readonly successes: number
  readonly pass1: number
  readonly passK?: number
}

export interface PassMetrics {
  /** Requested reliability horizon. */
  readonly k: number
  /** Mean per-task success rate. */
  readonly pass1: number
  /** Mean per-task `C(c, k) / C(n, k)`; absent when no task has k trials. */
  readonly passK?: number
  readonly tasks: TaskPassMetric[]
}

/** Binomial coefficient for small non-negative integers. */
export function binomial(n: number, k: number): number {
  if (!Number.isInteger(n) || !Number.isInteger(k) || n < 0 || k < 0 || k > n) return 0
  let result = 1
  for (let index = 1; index <= k; index += 1) {
    result = (result * (n - k + index)) / index
  }
  return result
}

/** Compute `pass^1` and `pass^k` per task, then average over tasks. */
export function computePassMetrics(trials: readonly PassTrial[], k = 3): PassMetrics {
  if (!Number.isInteger(k) || k < 1) {
    throw new TypeError(`k must be a positive integer: ${k}`)
  }

  const groups = new Map<string, PassTrial[]>()
  for (const trial of trials) {
    const key = `${trial.lang}\u0000${trial.taskId}`
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [trial])
    else group.push(trial)
  }

  const tasks: TaskPassMetric[] = []
  for (const group of groups.values()) {
    const first = group[0]
    if (first === undefined) continue
    const n = group.length
    const c = group.filter((trial) => trial.passed).length
    const passK = n >= k ? binomial(c, k) / binomial(n, k) : undefined
    tasks.push({
      lang: first.lang,
      taskId: first.taskId,
      trials: n,
      successes: c,
      pass1: c / n,
      ...(passK === undefined ? {} : { passK }),
    })
  }

  tasks.sort((left, right) =>
    left.lang === right.lang
      ? left.taskId.localeCompare(right.taskId)
      : left.lang.localeCompare(right.lang),
  )

  const pass1 =
    tasks.length === 0 ? 0 : tasks.reduce((total, task) => total + task.pass1, 0) / tasks.length
  const withK = tasks.filter((task) => task.passK !== undefined)
  const passK =
    withK.length === 0
      ? undefined
      : withK.reduce((total, task) => total + (task.passK ?? 0), 0) / withK.length

  return { k, pass1, ...(passK === undefined ? {} : { passK }), tasks }
}
