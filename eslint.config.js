const js = require("@eslint/js");

const nodeGlobals = {
  require: "readonly",
  module: "writable",
  process: "readonly",
  console: "readonly",
  Buffer: "readonly",
  __dirname: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  globalThis: "readonly",
  fetch: "readonly",
  URL: "readonly",
};

module.exports = [
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: nodeGlobals,
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-empty": ["warn", { allowEmptyCatch: true }],
    },
  },
  {
    // Mocha-style integration tests.
    files: ["test/integration/**/*.js"],
    languageOptions: {
      globals: { ...nodeGlobals, suite: "readonly", test: "readonly" },
    },
  },
  { ignores: ["node_modules/**", "media/**", "*.vsix", ".vscode-test/**"] },
];
