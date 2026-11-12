import { registerHooks } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Node entry for the M3b shadow run.
 *
 * Registers the repository's `.js` → `.ts` resolve hook before importing the
 * script, exactly like `tools/eval-harness-cli/src/cli.ts`.
 */
const entry = process.argv[1]
const isDirectExecution =
  entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url

if (isDirectExecution) {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context)
      } catch (error) {
        if (!specifier.endsWith('.js')) throw error
        if (!specifier.startsWith('./') && !specifier.startsWith('../')) throw error
        if (context.parentURL === undefined) throw error
        return nextResolve(new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL).href, context)
      }
    },
  })
}

await import('./m3b-shadow.js')
