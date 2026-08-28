export function activeGptUsage(snapshot) {
  if (!snapshot?.available || !Array.isArray(snapshot.providers)) return null;
  const provider = snapshot.providers.find((entry) => entry?.id === 'gpt');
  if (!provider || provider.available === false || !Array.isArray(provider.accounts)) {
    return null;
  }
  return provider.accounts.find((account) => account?.active) || null;
}

export function usageAccountStatus(account = {}) {
  const parts = [];
  if (account.fiveHourPercent !== null && account.fiveHourPercent !== undefined) {
    parts.push(`5h ${account.fiveHourPercent}%`);
  }
  if (account.weeklyPercent !== null && account.weeklyPercent !== undefined) {
    parts.push(`week ${account.weeklyPercent}%`);
  }
  if (account.stale && parts.length > 0) parts.push('cached');
  const blocked = Boolean(
    account.blocked || account.fiveHourBlocked || account.weeklyBlocked,
  );
  if (account.needsLogin) return { blocked, text: 'Needs sign-in' };
  if (blocked) {
    return {
      blocked,
      text: `${account.weeklyBlocked ? 'Weekly spent' : 'Limit hit'} · ${parts.join(' · ')}`,
    };
  }
  return { blocked, text: parts.join(' · ') || 'No data yet' };
}

export function createUsageReader({
  load,
  now = () => Date.now(),
  ttlMs = 60_000,
} = {}) {
  if (typeof load !== 'function') throw new TypeError('load is required');
  let cached = null;
  let cachedAt = 0;
  let inFlight = null;

  function read({ force = false } = {}) {
    if (inFlight) return inFlight;
    if (!force && cached && now() - cachedAt <= ttlMs) {
      return Promise.resolve(cached);
    }
    let loading;
    try {
      loading = Promise.resolve(load());
    } catch (error) {
      loading = Promise.reject(error);
    }
    inFlight = loading
      .then((value) => {
        cached = value;
        cachedAt = now();
        return cached;
      })
      .catch(() => {
        cached = cached?.available
          ? {
              ...cached,
              refreshFailed: true,
              providers: Array.isArray(cached.providers)
                ? cached.providers.map((provider) => ({
                    ...provider,
                    accounts: Array.isArray(provider.accounts)
                      ? provider.accounts.map((account) => ({
                          ...account,
                          stale: true,
                        }))
                      : [],
                  }))
                : [],
            }
          : { available: false, reason: 'producer_unreachable' };
        cachedAt = now();
        return cached;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  return {
    peek() {
      return cached;
    },
    read,
  };
}
