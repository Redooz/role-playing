#!/usr/bin/env node
import { registerHooks } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Direct-execution entry for the M3a comparison.
 *
 * Node strips types but does not rewrite `.js` specifiers to `.ts`, so the same
 * resolve hook used by the app/eval CLIs is registered before loading the runner.
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

await import('./compare-main.js')
