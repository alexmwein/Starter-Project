export const BOOTSTRAP_REQUEST_MS = 6_000;

export function createBootstrapCoordinator({
  load,
  onStart,
  onSuccess,
  onFailure,
  timeoutMs = BOOTSTRAP_REQUEST_MS,
}) {
  let generation = 0;
  let activeController = null;

  return {
    async run() {
      const runGeneration = ++generation;
      activeController?.abort(new Error('bootstrap_superseded'));
      const controller = new AbortController();
      activeController = controller;
      onStart();

      try {
        const value = await load({
          signal: controller.signal,
          timeoutMs,
        });
        if (runGeneration !== generation) return false;
        await onSuccess(value);
      } catch (error) {
        if (runGeneration !== generation) return false;
        await onFailure(error);
      } finally {
        if (runGeneration === generation) activeController = null;
      }
      return true;
    },
  };
}
