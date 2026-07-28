export function createLiveRefreshCoordinator({
  delayMs,
  run,
  onError = () => {},
}) {
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new TypeError('invalid_refresh_delay');
  }
  if (typeof run !== 'function' || typeof onError !== 'function') {
    throw new TypeError('invalid_refresh_handler');
  }

  let timer = null;
  let inFlight = null;
  let controller = null;
  let queued = false;
  let generation = 0;

  function schedule() {
    queued = true;
    if (timer !== null || inFlight) return;
    timer = setTimeout(() => {
      timer = null;
      void drain();
    }, delayMs);
  }

  async function drain() {
    if (inFlight) return inFlight;
    queued = false;
    const runGeneration = generation;
    const runController = new AbortController();
    controller = runController;
    const operation = Promise.resolve().then(() =>
      run({
        signal: runController.signal,
        generation: runGeneration,
      }),
    );
    inFlight = operation;
    try {
      await operation;
    } catch (error) {
      if (!runController.signal.aborted) onError(error);
    } finally {
      if (
        runGeneration !== generation ||
        inFlight !== operation
      ) {
        return;
      }
      inFlight = null;
      controller = null;
      if (queued) schedule();
    }
  }

  function stop() {
    generation += 1;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    queued = false;
    controller?.abort();
    controller = null;
    inFlight = null;
  }

  return {
    schedule,
    stop,
    flush: drain,
  };
}
