// Pure most-recently-used logic. No chrome.* so it can be tested with node --test.

export function touch(order, tabId) {
  return [tabId, ...order.filter((id) => id !== tabId)];
}

export function remove(order, tabId) {
  return order.filter((id) => id !== tabId);
}

export function isLoaded(tab) {
  return !tab.discarded && tab.status !== 'unloaded';
}

export function orderTabs(tabs, order) {
  const rank = new Map();
  order.forEach((id, index) => {
    if (!rank.has(id)) rank.set(id, index);
  });

  // filter() copies, so sorting here leaves the caller's array alone.
  return tabs.filter(isLoaded).sort((a, b) => {
    const rankA = rank.get(a.id);
    const rankB = rank.get(b.id);
    if (rankA !== undefined && rankB !== undefined) return rankA - rankB;
    if (rankA !== undefined) return -1;
    if (rankB !== undefined) return 1;
    return (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0);
  });
}
