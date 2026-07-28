const DEFAULT_CHECK_INTERVAL_MS = 30 * 1000;
const ACTIVE_DELIVERY_STATES = new Set(['delivering', 'confirming']);

export function appUpdateReloadIsSafe({
  originRetired = false,
  sensitiveOperations = 0,
  pairing = false,
  overlayOpen = false,
  composerValue = '',
  deliveries = [],
} = {}) {
  if (
    originRetired ||
    sensitiveOperations > 0 ||
    pairing ||
    overlayOpen ||
    typeof composerValue !== 'string' ||
    composerValue.length > 0 ||
    !Array.isArray(deliveries)
  ) {
    return false;
  }
  return !deliveries.some((message) =>
    ACTIVE_DELIVERY_STATES.has(message?.delivery),
  );
}

export function createServiceWorkerRegistrationGetter({
  serviceWorker,
  scriptUrl = '/service-worker.js',
  options = { updateViaCache: 'none' },
}) {
  if (!serviceWorker || typeof serviceWorker.register !== 'function') {
    throw new TypeError('invalid_service_worker_registration');
  }
  let registrationPromise = null;
  return function getRegistration() {
    if (!registrationPromise) {
      const attempt = Promise.resolve().then(() =>
        serviceWorker.register(scriptUrl, options),
      );
      registrationPromise = attempt;
      void attempt.catch(() => {
        if (registrationPromise === attempt) registrationPromise = null;
      });
    }
    return registrationPromise;
  };
}

export function createAppUpdateCoordinator({
  serviceWorker,
  getRegistration,
  canCheck = () => true,
  canReload,
  reload,
  isHidden = () => false,
  now = () => Date.now(),
  checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS,
}) {
  if (
    !serviceWorker ||
    typeof serviceWorker.addEventListener !== 'function' ||
    typeof serviceWorker.removeEventListener !== 'function' ||
    typeof getRegistration !== 'function' ||
    typeof canCheck !== 'function' ||
    typeof canReload !== 'function' ||
    typeof reload !== 'function' ||
    typeof isHidden !== 'function' ||
    !Number.isFinite(checkIntervalMs) ||
    checkIntervalMs < 0
  ) {
    throw new TypeError('invalid_app_update_coordinator');
  }

  let observedController = serviceWorker.controller || null;
  let updatePending = false;
  let reloadStarted = false;
  let checkInFlight = null;
  let lastCheckAt = Number.NEGATIVE_INFINITY;
  let started = false;

  function applyIfSafe() {
    if (!updatePending || reloadStarted) return false;
    if (isHidden()) return false;
    let safe = false;
    try {
      safe = canReload() === true;
    } catch {
      safe = false;
    }
    if (!safe) return false;
    reloadStarted = true;
    try {
      reload();
      return true;
    } catch {
      reloadStarted = false;
      return false;
    }
  }

  function observeController() {
    const controller = serviceWorker.controller || null;
    if (controller === observedController) return false;
    const previousController = observedController;
    observedController = controller;
    if (!started) return false;
    if (previousController && controller) {
      updatePending = true;
      applyIfSafe();
      return true;
    }
    return false;
  }

  function onControllerChange() {
    observeController();
  }

  async function checkForUpdate({ force = false } = {}) {
    try {
      if (!canCheck() || isHidden()) return false;
    } catch {
      return false;
    }
    observeController();
    applyIfSafe();
    if (checkInFlight) return checkInFlight;
    const checkedAt = now();
    if (!force && checkedAt - lastCheckAt < checkIntervalMs) return false;
    lastCheckAt = checkedAt;
    checkInFlight = (async () => {
      try {
        const registration = await getRegistration();
        if (!registration || typeof registration.update !== 'function') {
          return false;
        }
        await registration.update();
        observeController();
        applyIfSafe();
        return true;
      } catch {
        lastCheckAt = Number.NEGATIVE_INFINITY;
        return false;
      } finally {
        checkInFlight = null;
      }
    })();
    return checkInFlight;
  }

  function foreground() {
    if (isHidden()) return false;
    observeController();
    const reloading = applyIfSafe();
    void checkForUpdate({ force: true });
    return reloading;
  }

  function stateChanged() {
    observeController();
    return applyIfSafe();
  }

  function start() {
    if (started) return;
    started = true;
    serviceWorker.addEventListener('controllerchange', onControllerChange);
    observeController();
  }

  function stop() {
    if (!started) return;
    started = false;
    serviceWorker.removeEventListener('controllerchange', onControllerChange);
    updatePending = false;
    reloadStarted = false;
  }

  return {
    start,
    stop,
    foreground,
    stateChanged,
    checkForUpdate,
  };
}
