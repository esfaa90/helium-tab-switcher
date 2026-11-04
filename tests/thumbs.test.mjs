import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { selectEvictions, scaledSize, THUMB_WIDTH, THUMB_MAX_BYTES } from '../src/lib/thumbs.js';

const entry = (tabId, size, lastUsed) => ({ tabId, size, lastUsed });

describe('constants', () => {
  test('match the contract: 320 px wide and 8 MB', () => {
    assert.equal(THUMB_WIDTH, 320);
    assert.equal(THUMB_MAX_BYTES, 8 * 1024 * 1024);
  });
});

describe('selectEvictions', () => {
  test('nothing to evict from an empty list', () => {
    assert.deepEqual(selectEvictions([], 100), []);
  });

  test('nothing to evict when under the limit', () => {
    assert.deepEqual(selectEvictions([entry(1, 10, 1), entry(2, 10, 2)], 100), []);
  });

  test('evicts the least recently used first, whatever the input order', () => {
    const entries = [entry(1, 60, 300), entry(2, 60, 100), entry(3, 60, 200)];
    assert.deepEqual(selectEvictions(entries, 100), [2, 3]);
  });

  test('evicts only as many as it needs', () => {
    const entries = [entry(1, 50, 1), entry(2, 50, 2), entry(3, 50, 3)];
    assert.deepEqual(selectEvictions(entries, 120), [1]);
  });

  test('does not skip a small old entry in favour of a large newer one', () => {
    const entries = [entry(1, 1, 1), entry(2, 100, 2), entry(3, 10, 3)];
    assert.deepEqual(selectEvictions(entries, 105), [1, 2]);
  });

  test('evicts everything when even the newest entry is over the limit', () => {
    const entries = [entry(1, 500, 1), entry(2, 500, 2)];
    assert.deepEqual(selectEvictions(entries, 100), [1, 2]);
  });

  test('what is left always fits', () => {
    const entries = Array.from({ length: 50 }, (_, i) => entry(i, 7 + (i % 5), i));
    const evicted = new Set(selectEvictions(entries, 100));
    const left = entries.filter((e) => !evicted.has(e.tabId)).reduce((sum, e) => sum + e.size, 0);
    assert.ok(left <= 100, `${left} bytes left`);
  });

  test('does not mutate its input', () => {
    const entries = [entry(1, 60, 3), entry(2, 60, 1), entry(3, 60, 2)];
    const before = structuredClone(entries);
    Object.freeze(entries);
    entries.forEach(Object.freeze);
    selectEvictions(entries, 100);
    assert.deepEqual(entries, before);
  });
});

describe('scaledSize', () => {
  test('scales a wide capture down and keeps the aspect ratio', () => {
    assert.deepEqual(scaledSize(1920, 1080, 320), { width: 320, height: 180 });
  });

  test('uses the contract width of 320 by default', () => {
    assert.deepEqual(scaledSize(1600, 900), { width: 320, height: 180 });
  });

  test('never upscales', () => {
    assert.deepEqual(scaledSize(200, 100, 320), { width: 200, height: 100 });
  });

  test('a capture exactly at the limit is unchanged', () => {
    assert.deepEqual(scaledSize(320, 240, 320), { width: 320, height: 240 });
  });

  test('rounds the height to a whole pixel', () => {
    assert.deepEqual(scaledSize(1000, 333, 320), { width: 320, height: 107 });
  });

  test('a very wide capture never gets a height of 0', () => {
    assert.deepEqual(scaledSize(100000, 10, 320), { width: 320, height: 1 });
  });

  test('a tall capture is limited by width only', () => {
    assert.deepEqual(scaledSize(640, 4000, 320), { width: 320, height: 2000 });
  });
});
