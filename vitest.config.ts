import { defineConfig } from 'vitest/config'

/**
 * Two Vitest projects, per the M0 plan (D1):
 * - `unit`  — fast, runs on every change and in the PR gate.
 * - `bench` — wall-time measurements, never part of the PR gate.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['{apps,packages,tools}/**/*.spec.ts'],
          exclude: ['**/node_modules/**', '**/dist/**', '**/*.bench.spec.ts'],
        },
      },
      {
        test: {
          name: 'bench',
          environment: 'node',
          include: ['{apps,packages,tools}/**/*.bench.spec.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
        },
      },
    ],
  },
})
