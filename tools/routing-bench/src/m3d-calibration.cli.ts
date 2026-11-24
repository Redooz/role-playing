import { registerHooks } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Node entry for the M3d D3 offline calibration comparison.
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
        const typescriptSpecifier = `${specifier.slice(0, -3)}.ts`
        return nextResolve(new URL(typescriptSpecifier, context.parentURL).href, context)
      }
    },
  })
  const { main } = await import('./m3d-calibration.js')
  await main(process.argv.slice(2))
}
