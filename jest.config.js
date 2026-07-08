/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src", "<rootDir>/config"],
  testMatch: ["**/*.test.ts"],
  moduleFileExtensions: ["ts", "js", "json"],
  setupFiles: ["<rootDir>/src/test-setup.ts"],
  // Under TypeScript 6, ts-jest no longer auto-includes @types/jest for this
  // project, so every test failed with "Cannot find name 'it'". Point ts-jest
  // at a test tsconfig that lists the jest/node ambient types explicitly.
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: "tsconfig.test.json" }],
  },
  // Thread workspaces under /tmp/slack-ai-agent/workspaces/ are shared across
  // workers; run serially for determinism.
  maxWorkers: 1,
};
