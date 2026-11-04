import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { touch, remove, isLoaded, orderTabs } from '../src/lib/mru.js';

const tab = (id, extra = {}) => ({ id, status: 'complete', discarded: false, lastAccessed: 0, ...extra });
const ids = (tabs) => tabs.map((t) => t.id);

describe('touch', () => {
  test('adds a new id at the front', () => {
    assert.deepEqual(touch([1, 2], 3), [3, 1, 2]);
  });

  test('moves an existing id to the front without duplicating it', () => {
    assert.deepEqual(touch([1, 2, 3], 3), [3, 1, 2]);
  });

  test('works on an empty order', () => {
    assert.deepEqual(touch([], 7), [7]);
  });

  test('returns a new array and leaves the input alone', () => {
    const order = Object.freeze([1, 2, 3]);
    const result = touch(order, 1);
    assert.notEqual(result, order);
    assert.deepEqual(order, [1, 2, 3]);
  });
});

describe('remove', () => {
  test('removes the id', () => {
    assert.deepEqual(remove([1, 2, 3], 2), [1, 3]);
  });

  test('an id that is not present changes nothing', () => {
    assert.deepEqual(remove([1, 2], 9), [1, 2]);
  });

  test('returns a new array and leaves the input alone', () => {
    const order = Object.freeze([1, 2]);
    const result = remove(order, 9);
    assert.notEqual(result, order);
    assert.deepEqual(order, [1, 2]);
  });
});

describe('isLoaded', () => {
  test('an ordinary complete tab is loaded', () => {
    assert.equal(isLoaded(tab(1)), true);
  });

  test('a tab that is still loading is loaded', () => {
    assert.equal(isLoaded(tab(1, { status: 'loading' })), true);
  });

  test('a discarded tab is not loaded', () => {
    assert.equal(isLoaded(tab(1, { discarded: true })), false);
  });

  test("status 'unloaded' is not loaded", () => {
    assert.equal(isLoaded(tab(1, { status: 'unloaded' })), false);
  });

  test('a frozen tab still counts as loaded', () => {
    assert.equal(isLoaded(tab(1, { frozen: true })), true);
  });

  test('a frozen and discarded tab is not loaded', () => {
    assert.equal(isLoaded(tab(1, { frozen: true, discarded: true })), false);
  });
});

describe('orderTabs', () => {
  test('keeps loaded tabs only, including frozen ones', () => {
    const tabs = [
      tab(1),
      tab(2, { discarded: true }),
      tab(3, { status: 'unloaded' }),
      tab(4, { frozen: true }),
    ];
    assert.deepEqual(ids(orderTabs(tabs, [1, 4])), [1, 4]);
  });

  test('an unloaded tab is dropped even if it is first in the order', () => {
    const tabs = [tab(1, { discarded: true }), tab(2)];
    assert.deepEqual(ids(orderTabs(tabs, [1, 2])), [2]);
  });

  test('tabs in order come first, in that order', () => {
    const tabs = [tab(1), tab(2), tab(3)];
    assert.deepEqual(ids(orderTabs(tabs, [3, 1, 2])), [3, 1, 2]);
  });

  test('order beats lastAccessed', () => {
    const tabs = [tab(1, { lastAccessed: 1 }), tab(2, { lastAccessed: 999 })];
    assert.deepEqual(ids(orderTabs(tabs, [1])), [1, 2]);
    assert.deepEqual(ids(orderTabs(tabs, [1, 2])), [1, 2]);
  });

  test('unknown tabs follow by lastAccessed descending', () => {
    const tabs = [
      tab(1, { lastAccessed: 100 }),
      tab(2, { lastAccessed: 300 }),
      tab(3, { lastAccessed: 200 }),
      tab(4, { lastAccessed: 50 }),
    ];
    assert.deepEqual(ids(orderTabs(tabs, [4])), [4, 2, 3, 1]);
  });

  test('with an empty order everything sorts by lastAccessed descending', () => {
    const tabs = [tab(1, { lastAccessed: 1 }), tab(2, { lastAccessed: 2 })];
    assert.deepEqual(ids(orderTabs(tabs, [])), [2, 1]);
  });

  test('ids in order that no longer exist are ignored', () => {
    const tabs = [tab(1), tab(2)];
    assert.deepEqual(ids(orderTabs(tabs, [99, 2, 98, 1, 97])), [2, 1]);
  });

  test('no tabs gives an empty list', () => {
    assert.deepEqual(orderTabs([], [1, 2]), []);
  });

  test('does not mutate its inputs', () => {
    const tabs = [tab(1, { lastAccessed: 1 }), tab(2, { lastAccessed: 2 }), tab(3, { discarded: true })];
    const order = [3];
    const tabsBefore = structuredClone(tabs);
    Object.freeze(tabs);
    tabs.forEach(Object.freeze);
    Object.freeze(order);

    // Frozen inputs make an in-place sort or a write throw, as well as being compared afterwards.
    const result = orderTabs(tabs, order);

    assert.deepEqual(ids(result), [2, 1]);
    assert.notEqual(result, tabs);
    assert.deepEqual(tabs, tabsBefore);
    assert.deepEqual(order, [3]);
  });
});
