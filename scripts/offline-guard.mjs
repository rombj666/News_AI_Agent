// Normal tests and demos cannot accidentally call a real provider through fetch,
// even when the developer's shell contains API keys. Tests inject their own mocks.
globalThis.fetch = async () => {
  throw new Error('Network disabled for offline tests/demo. Use the explicit live retrieval command.');
};
