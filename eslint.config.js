import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules', 'data', 'test/fixtures'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
);
