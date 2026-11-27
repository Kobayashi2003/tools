import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default [
  { ignores: ['patches/**'] },
  js.configs.recommended,
  { languageOptions: { globals: globals.node } },
  prettier,
];
