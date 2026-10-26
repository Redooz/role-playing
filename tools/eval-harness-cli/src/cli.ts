import { registerHooks } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Node entry for `tools/eval-harness-cli/src/cli.ts`.
 *
 * The repository compiles with `module: nodenext` and `.js` import specifiers
 * (the TypeScript requirement), while Node 26 strips types from `.ts` files but
 * does not rewrite `.js` → `.ts`. npm runs this file directly from source, so
 * the entry registers a resolve hook that retries a failed relative `.js`
 * specifier as `.ts`. The hook is scoped to direct execution: under Vitest the
 * test runner already resolves the source files and the hook is not installed.
 *
 * No build step is required for `npm run eval` or `npm run validate:tasks`.
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
}

const { main } = await import('./cli-main.js')

if (isDirectExecution) {
  process.exitCode = await main(process.argv.slice(2))
}
