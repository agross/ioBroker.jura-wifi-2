import config from '@iobroker/eslint-config';

export default [
  ...config,
  {
    rules: {
      // Keep the existing formatting, inferred return types, and JSDoc conventions.
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      curly: 'off',
      'jsdoc/require-jsdoc': 'off',
      'prefer-template': 'off',
      'prettier/prettier': 'off',
    },
  },
  {
    files: ['main.ts'],
    rules: {
      // ioBroker extends its global AdapterConfig namespace through declaration merging.
      '@typescript-eslint/no-namespace': ['error', { allowDeclarations: true }],
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      // The test runner tracks registered tests, and mocks implement async adapter APIs.
      '@typescript-eslint/no-floating-promises': [
        'error',
        { allowForKnownSafeCalls: [{ from: 'package', name: 'test', package: 'node:test' }] },
      ],
      '@typescript-eslint/require-await': 'off',
    },
  },
];
