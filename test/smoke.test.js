import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('Smoke test', () => {
  it('Node:test framework is working', () => {
    assert.equal(1 + 1, 2);
  });
});