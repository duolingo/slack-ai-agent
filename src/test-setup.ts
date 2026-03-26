// Silence console output during tests to keep output clean.
// This runs as a setupFile (before test framework), so we patch directly.
console.log = () => {};
console.warn = () => {};
console.error = () => {};
