import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // *.workflow.mjs are Workflow-runtime scripts (top-level await/return, injected
  // agent()/phase()/log() globals) — not valid standalone ES modules, so espree
  // parse-errors on them. They run only under the Workflow tool, never linted here.
  // Flat-config ESLint does not inherit .gitignore. Exclude generated/build
  // trees explicitly so lint neither walks a 17GB Rust target directory nor
  // races Cargo while temporary rmeta directories are being replaced.
  globalIgnores([
    'dist',
    'coverage',
    'target',
    'recommender/.venv*',
    '.claude',
    '.planning',
    '.netlify',
    'playwright-report',
    'test-results',
    '**/*.workflow.mjs',
  ]),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
])
