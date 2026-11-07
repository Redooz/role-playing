import { registerHooks } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Node entry for the text session CLI.
 *
 * The repository compiles with `module: nodenext` and `.js` import specifiers,
 * while Node 26 strips types from `.ts` files but does not rewrite `.js` → `.ts`.
 * Registering a resolve hook for direct execution lets `npm run chat` run this
 * file from source, exactly like `tools/eval-harness-cli`.
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

const { main } = await import('./main.js')

if (isDirectExecution) {
  process.exitCode = await main(process.argv.slice(2))
}
