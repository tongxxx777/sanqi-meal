module.exports = {
  env: {
    es2020: true,
    browser: true,
    node: true,
  },
  parserOptions: {
    ecmaVersion: 2020,
    sourceType: 'module',
  },
  globals: {
    wx: 'readonly',
    App: 'readonly',
    Page: 'readonly',
    getCurrentPages: 'readonly',
    getApp: 'readonly',
    Component: 'readonly',
    Behavior: 'readonly',
    requirePlugin: 'readonly',
    requireMiniProgram: 'readonly',
  },
  rules: {},
}
