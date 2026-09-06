const browserGlobals = {
  window: "readonly",
  document: "readonly",
  navigator: "readonly",
  fetch: "readonly",
  performance: "readonly",
  requestAnimationFrame: "readonly",
  Image: "readonly",
  console: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  AbortController: "readonly"
};

const nodeGlobals = {
  process: "readonly",
  console: "readonly",
  URL: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setImmediate: "readonly",
  // Node 18+ provides the WHATWG fetch API globally; the worker tests use it
  // directly to build fake Request/Response objects.
  fetch: "readonly",
  Request: "readonly",
  Response: "readonly",
  Headers: "readonly",
  AbortController: "readonly"
};

const workerGlobals = {
  fetch: "readonly",
  console: "readonly",
  Request: "readonly",
  Response: "readonly",
  Headers: "readonly",
  AbortController: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  caches: "readonly"
};

export default [
  {
    ignores: ["node_modules/**", "public/**", "test-results/**", "playwright-report/**"]
  },
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: browserGlobals
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": "warn"
    }
  },
  {
    files: ["worker/src/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: workerGlobals
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": "warn"
    }
  },
  {
    files: ["scripts/**/*.mjs", "test/unit/**/*.mjs", "test/unit/**/*.js", "test/fixtures/**/*.mjs", "eslint.config.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: nodeGlobals
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": "warn"
    }
  },
  {
    // e2e tests (and helpers like geolocation.mjs) embed page.evaluate()/
    // addInitScript() callbacks that run in the browser, so these files need
    // both Node and browser globals available.
    files: ["test/e2e/**/*.mjs", "test/e2e/**/*.js", "test/helpers/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...nodeGlobals, ...browserGlobals }
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": "warn"
    }
  }
];
