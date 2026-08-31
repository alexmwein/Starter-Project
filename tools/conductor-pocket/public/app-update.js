const DEFAULT_CHECK_INTERVAL_MS = 30 * 1000;
const ACTIVE_DELIVERY_STATES = new Set(['delivering', 'confirming']);

export function appUpdateReloadIsSafe({
  originRetired = false,
  sensitiveOperations = 0,
  pairing = false,
  overlayOpen = false,
  composerValue = '',
  persistedComposerValue = '',
  deliveries = [],
  attachmentCount = 0,
} = {}) {
  if (
    originRetired ||
    sensitiveOperations > 0 ||
    pairing ||
    overlayOpen ||
    typeof composerValue !== 'string' ||
    typeof persistedComposerValue !== 'string' ||
    composerValue !== persistedComposerValue ||
    !Array.isArray(deliveries) ||
    !Number.isSafeInteger(attachmentCount) ||
    attachmentCount !== 0
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
  clientRevision = null,
  getServerRevision = null,
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
    (clientRevision !== null && typeof clientRevision !== 'string') ||
    (getServerRevision !== null &&
      typeof getServerRevision !== 'function') ||
    typeof isHidden !== 'function' ||
    !Number.isFinite(checkIntervalMs) ||
    checkIntervalMs < 0
  ) {
    throw new TypeError('invalid_app_update_coordinator');
  }

  let observedController = serviceWorker.controller || null;
  let updatePending = false;
  let pendingRevision = null;
  let reloadStarted = false;
  let checkInFlight = null;
  let lastCheckAt = Number.NEGATIVE_INFINITY;
  let started = false;

  // A reload can land on a shell that still reports the old revision (the
  // document is served cache first), which makes the coordinator see the same
  // update again and reload again, forever. reloadStarted only guards within a
  // single page life, so it cannot see that pattern. This counter persists
  // across reloads for the tab, so after a couple of attempts for the SAME
  // revision the app stops reloading itself and waits to be applied manually
  // rather than spinning. A genuinely new revision resets the count.
  const RELOAD_ATTEMPT_KEY = 'pocket:update-attempts';
  const MAX_RELOAD_ATTEMPTS = 2;

  function reloadAttempts(revision) {
    try {
      const raw = globalThis.sessionStorage?.getItem(RELOAD_ATTEMPT_KEY);
      if (!raw) return 0;
      const parsed = JSON.parse(raw);
      return parsed?.revision === revision && Number.isSafeInteger(parsed.count)
        ? parsed.count
        : 0;
    } catch {
      return 0;
    }
  }

  function recordReloadAttempt(revision) {
    try {
      globalThis.sessionStorage?.setItem(
        RELOAD_ATTEMPT_KEY,
        JSON.stringify({ revision, count: reloadAttempts(revision) + 1 }),
      );
    } catch {
      // Storage being unavailable must never block a legitimate update.
    }
  }

  function clearReloadAttempts() {
    try {
      globalThis.sessionStorage?.removeItem(RELOAD_ATTEMPT_KEY);
    } catch {
      // Nothing to clean up.
    }
  }

  function applyIfSafe() {
    if (!updatePending || reloadStarted) return false;
    if (isHidden()) return false;
    if (reloadAttempts(pendingRevision) >= MAX_RELOAD_ATTEMPTS) return false;
    let safe = false;
    try {
      safe = canReload() === true;
    } catch {
      safe = false;
    }
    if (!safe) return false;
    reloadStarted = true;
    try {
      recordReloadAttempt(pendingRevision);
      reload(pendingRevision);
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

  function serverRevision(revision) {
    if (typeof revision === 'string' && revision === clientRevision) {
      // The running shell is current, so any earlier attempts succeeded and the
      // counter must not leak into the next genuine update.
      clearReloadAttempts();
    }
    if (
      !clientRevision ||
      typeof revision !== 'string' ||
      revision.length === 0 ||
      revision === clientRevision
    ) {
      return false;
    }
    updatePending = true;
    pendingRevision = revision;
    applyIfSafe();
    return true;
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
        const revisionCheck = getServerRevision
          ? Promise.resolve()
              .then(() => getServerRevision())
              .then((revision) => serverRevision(revision))
          : Promise.resolve(false);
        await Promise.all([
          registration.update(),
          revisionCheck,
        ]);
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
    pendingRevision = null;
    reloadStarted = false;
  }

  return {
    start,
    stop,
    foreground,
    stateChanged,
    serverRevision,
    checkForUpdate,
  };
}
