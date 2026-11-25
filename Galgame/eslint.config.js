import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default [
  { ignores: ['nnn-voice-continue/patches/**'] },
  js.configs.recommended,
  { languageOptions: { globals: globals.node } },
  prettier,
];
