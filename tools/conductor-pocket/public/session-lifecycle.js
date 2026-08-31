const DAY_MS = 24 * 60 * 60 * 1000;
const WARNING_WINDOW_MS = 5 * DAY_MS;

export function connectionLifecycleState({
  relayReachable,
  authenticated,
}) {
  if (!relayReachable) return 'unreachable';
  return authenticated ? 'authenticated' : 'unauthenticated';
}

export function bootstrapFailureState(error = {}) {
  if (
    error.status === 401 ||
    error.code === 'authentication_required' ||
    error.code === 'device_session_expired'
  ) {
    return {
      state: 'unauthenticated',
      title: 'Session expired',
      body: 'Unlock with Face ID to reconnect this iPhone.',
      action: 'Unlock with Face ID',
    };
  }
  return {
    state: 'unreachable',
    title: 'Mac unreachable',
    body: 'Conductor Pocket could not reach the relay on your Mac.',
    action: 'Try again',
  };
}

export function sessionExpiryNotice({ now = Date.now(), device } = {}) {
  const deadlines = [device?.trustedUntil, device?.sessionExpiresAt]
    .map(Date.parse)
    .filter(Number.isFinite);
  if (deadlines.length === 0) return null;
  const remaining = Math.min(...deadlines) - now;
  if (remaining <= 0 || remaining > WARNING_WINDOW_MS) return null;
  const daysRemaining = Math.max(1, Math.ceil(remaining / DAY_MS));
  return {
    daysRemaining,
    text:
      `This iPhone session expires in ${daysRemaining} ` +
      `day${daysRemaining === 1 ? '' : 's'}. ` +
      'Unlock with Face ID before then.',
  };
}
