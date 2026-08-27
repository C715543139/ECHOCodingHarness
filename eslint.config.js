import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['.echo/', 'coverage/', 'dist/', 'node_modules/'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strict,
  ...tseslint.configs.stylistic,
  {
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  prettier,
);
