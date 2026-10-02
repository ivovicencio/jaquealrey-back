/**
 * Configuracion de ESLint (flat config, ESLint 10).
 *
 * El objetivo es bajo y concreto: atrapar errores, no imponer estilo. Por eso el
 * estilo (sangrias, comillas, ancho de linea) lo define Prettier, y aca solo se
 * activan las reglas que detectan bugs reales.
 *
 * `npm run lint:fix` corrige lo automatico; `npm run format` aplica Prettier.
 */

const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
  {
    ignores: ["node_modules/**", "coverage/**", ".env", "*.log"],
  },

  // Reglas recomendadas de ESLint (no-undef, no-dupe-keys, no-unreachable, ...).
  js.configs.recommended,

  // Todo el proyecto: CommonJS de Node.
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "commonjs",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // --- Errores que de verdad rompen ---
      "no-undef": "error",
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_|^next$", varsIgnorePattern: "^_" }],
      "no-dupe-keys": "error",
      "no-dupe-args": "error",
      "no-duplicate-case": "error",
      "no-unreachable": "error",
      "no-const-assign": "error",
      "no-func-assign": "error",
      "no-self-compare": "error",
      "no-unsafe-negation": "error",
      "use-isnan": "error",
      "valid-typeof": "error",

      // --- Higiene ---
      eqeqeq: ["warn", "smart"],
      "no-var": "warn",
      "prefer-const": "warn",
      "no-throw-literal": "error",
      "no-return-await": "error",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-console": "off",
    },
  },

  // Los tests usan `next` como parametro sin usar y redeclaran fixtures.
  {
    files: ["tests/**/*.js"],
    rules: {
      "no-unused-vars": "off",
    },
  },
];
