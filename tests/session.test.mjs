import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, step, removeItem, selectedTabId } from '../src/lib/session.js';

const items = (...tabIds) => tabIds.map((tabId) => ({ tabId, title: `tab ${tabId}` }));
const at = (selectedIndex, ...tabIds) => ({ id: 's', windowId: 1, items: items(...tabIds), selectedIndex });

// Frozen all the way down, so any write inside the function under test throws.
function deepFreeze(session) {
  session.items.forEach(Object.freeze);
  Object.freeze(session.items);
  return Object.freeze(session);
}

describe('createSession', () => {
  test('returns the contract shape', () => {
    const list = items(1, 2, 3);
    assert.deepEqual(createSession('abc', 7, list, 'next'), {
      id: 'abc',
      windowId: 7,
      items: list,
      selectedIndex: 1,
    });
  });

  test('next starts at index 1', () => {
    assert.equal(createSession('s', 1, items(1, 2, 3), 'next').selectedIndex, 1);
  });

  test('prev starts at the last index', () => {
    assert.equal(createSession('s', 1, items(1, 2, 3, 4), 'prev').selectedIndex, 3);
  });

  test('two items: both directions land on index 1', () => {
    assert.equal(createSession('s', 1, items(1, 2), 'next').selectedIndex, 1);
    assert.equal(createSession('s', 1, items(1, 2), 'prev').selectedIndex, 1);
  });

  test('one item starts at 0 in both directions', () => {
    assert.equal(createSession('s', 1, items(1), 'next').selectedIndex, 0);
    assert.equal(createSession('s', 1, items(1), 'prev').selectedIndex, 0);
  });

  test('no items starts at 0 in both directions', () => {
    assert.equal(createSession('s', 1, [], 'next').selectedIndex, 0);
    assert.equal(createSession('s', 1, [], 'prev').selectedIndex, 0);
  });
});

describe('step', () => {
  test('next moves forward', () => {
    assert.equal(step(at(0, 1, 2, 3), 'next').selectedIndex, 1);
  });

  test('prev moves back', () => {
    assert.equal(step(at(2, 1, 2, 3), 'prev').selectedIndex, 1);
  });

  test('next wraps from the end to the start', () => {
    assert.equal(step(at(2, 1, 2, 3), 'next').selectedIndex, 0);
  });

  test('prev wraps from the start to the end', () => {
    assert.equal(step(at(0, 1, 2, 3), 'prev').selectedIndex, 2);
  });

  test('one item stays on it in both directions', () => {
    assert.equal(step(at(0, 1), 'next').selectedIndex, 0);
    assert.equal(step(at(0, 1), 'prev').selectedIndex, 0);
  });

  test('no items does not produce a bad index', () => {
    assert.equal(step(at(0), 'next').selectedIndex, 0);
    assert.equal(step(at(0), 'prev').selectedIndex, 0);
  });

  test('returns a new session and leaves the input alone', () => {
    const session = deepFreeze(at(0, 1, 2));
    const result = step(session, 'next');
    assert.notEqual(result, session);
    assert.equal(session.selectedIndex, 0);
    assert.equal(result.id, 's');
    assert.equal(result.windowId, 1);
    assert.deepEqual(result.items, session.items);
  });
});

describe('removeItem', () => {
  test('before the selection: the selection stays on the same tab', () => {
    const result = removeItem(at(2, 10, 20, 30, 40), 10);
    assert.deepEqual(result.items.map((i) => i.tabId), [20, 30, 40]);
    assert.equal(result.selectedIndex, 1);
    assert.equal(selectedTabId(result), 30);
  });

  test('at the selection: the index holds and the next item is selected', () => {
    const result = removeItem(at(1, 10, 20, 30), 20);
    assert.deepEqual(result.items.map((i) => i.tabId), [10, 30]);
    assert.equal(result.selectedIndex, 1);
    assert.equal(selectedTabId(result), 30);
  });

  test('after the selection: the selection does not move', () => {
    const result = removeItem(at(0, 10, 20, 30), 30);
    assert.deepEqual(result.items.map((i) => i.tabId), [10, 20]);
    assert.equal(result.selectedIndex, 0);
    assert.equal(selectedTabId(result), 10);
  });

  test('removing the last item while it is selected clamps the index', () => {
    const result = removeItem(at(2, 10, 20, 30), 30);
    assert.equal(result.selectedIndex, 1);
    assert.equal(selectedTabId(result), 20);
  });

  test('removing the last item while another is selected keeps the selection', () => {
    const result = removeItem(at(1, 10, 20, 30), 30);
    assert.equal(result.selectedIndex, 1);
    assert.equal(selectedTabId(result), 20);
  });

  test('removing the first item while it is selected keeps index 0', () => {
    const result = removeItem(at(0, 10, 20), 10);
    assert.equal(result.selectedIndex, 0);
    assert.equal(selectedTabId(result), 20);
  });

  test('removing the only item leaves an empty session at index 0', () => {
    const result = removeItem(at(0, 10), 10);
    assert.deepEqual(result.items, []);
    assert.equal(result.selectedIndex, 0);
    assert.equal(selectedTabId(result), null);
  });

  test('a tab that is not in the session changes nothing', () => {
    const result = removeItem(at(1, 10, 20), 99);
    assert.deepEqual(result.items.map((i) => i.tabId), [10, 20]);
    assert.equal(result.selectedIndex, 1);
  });

  test('keeps id and windowId', () => {
    const result = removeItem(at(0, 10, 20), 20);
    assert.equal(result.id, 's');
    assert.equal(result.windowId, 1);
  });

  test('returns a new session and leaves the input alone', () => {
    const session = deepFreeze(at(1, 10, 20, 30));
    const result = removeItem(session, 10);
    assert.notEqual(result, session);
    assert.notEqual(result.items, session.items);
    assert.equal(session.selectedIndex, 1);
    assert.deepEqual(session.items.map((i) => i.tabId), [10, 20, 30]);
  });
});

describe('selectedTabId', () => {
  test('returns the selected tab id', () => {
    assert.equal(selectedTabId(at(1, 10, 20)), 20);
  });

  test('returns null with no items', () => {
    assert.equal(selectedTabId(at(0)), null);
  });

  test('tab id 0 is returned, not treated as missing', () => {
    assert.equal(selectedTabId(at(0, 0, 1)), 0);
  });
});
