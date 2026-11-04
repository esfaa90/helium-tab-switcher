// Pure switcher session logic. No chrome.* so it can be tested with node --test.

export function createSession(id, windowId, items, direction) {
  let selectedIndex = 0;
  if (items.length > 1) {
    selectedIndex = direction === 'prev' ? items.length - 1 : 1;
  }
  return { id, windowId, items, selectedIndex };
}

export function step(session, direction) {
  const count = session.items.length;
  if (count === 0) return { ...session };
  const delta = direction === 'prev' ? -1 : 1;
  return { ...session, selectedIndex: (session.selectedIndex + delta + count) % count };
}

export function removeItem(session, tabId) {
  const removedIndex = session.items.findIndex((item) => item.tabId === tabId);
  if (removedIndex === -1) return { ...session };

  const items = session.items.filter((item) => item.tabId !== tabId);
  // Removing an earlier item shifts everything left, so follow the selected tab.
  let selectedIndex = session.selectedIndex;
  if (removedIndex < selectedIndex) selectedIndex -= 1;
  selectedIndex = Math.max(0, Math.min(selectedIndex, items.length - 1));
  return { ...session, items, selectedIndex };
}

export function selectedTabId(session) {
  return session.items[session.selectedIndex]?.tabId ?? null;
}
