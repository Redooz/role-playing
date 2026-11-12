import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/*.tsbuildinfo',
      '**/.stryker-tmp/**',
      'evals/results/**',
      'evals/.cache/**',
      'docs/**',
      '.agents/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Behaviour-bearing packages: the same surface the mutation floor protects.
    // A module that outgrows this budget usually owns more than one transition
    // family; split it rather than exempting it.
    files: [
      'packages/shared/src/**/*.ts',
      'packages/session-core/src/**/*.ts',
      'packages/pipeline/src/**/*.ts',
      'packages/persona-kit/src/**/*.ts',
      'packages/scenario-kit/src/**/*.ts',
      'packages/routing-policy/src/**/*.ts',
      'packages/turn-arbiter/src/**/*.ts',
      'apps/cli/src/**/*.ts',
    ],
    ignores: ['**/*.spec.ts'],
    rules: {
      'max-lines': ['error', { max: 450, skipBlankLines: true, skipComments: true }],
    },
  },
  prettier,
)
