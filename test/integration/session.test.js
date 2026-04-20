import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SessionState, isConfirmationWord } from '../../lib/security.js';
import { COMMANDS } from '../../lib/commands.js';

describe('Session State Integration Tests', () => {
  it('command during AWAITING_CONFIRMATION resets to IDLE', () => {
    // Mirrors the webhook handler's command-reset logic
    function shouldResetToIdle(state, text) {
      if (state === SessionState.IDLE) return false;
      if (isConfirmationWord(text)) return false;
      return COMMANDS.has(text) || /^\/\w+\s+/.test(text);
    }

    assert.ok(shouldResetToIdle(SessionState.AWAITING_CONFIRMATION, 'hoje'));
    assert.ok(shouldResetToIdle(SessionState.AWAITING_CONFIRMATION, '/hoje'));
    assert.ok(shouldResetToIdle(SessionState.AWAITING_DEBT_CONFIRMATION, '/ajuda'));
    assert.ok(!shouldResetToIdle(SessionState.IDLE, '/hoje'));
    assert.ok(!shouldResetToIdle(SessionState.AWAITING_CONFIRMATION, 'sim'));
    assert.ok(!shouldResetToIdle(SessionState.AWAITING_CONFIRMATION, 'nao'));
    assert.ok(!shouldResetToIdle(SessionState.AWAITING_CONFIRMATION, 'vendi 5000'));
  });

  it('all SessionState values are distinct strings', () => {
    const values = Object.values(SessionState);
    assert.equal(new Set(values).size, values.length);
  });

  it('AWAITING_DESFAZER_CONFIRM is included in SessionState', () => {
    assert.ok(SessionState.AWAITING_DESFAZER_CONFIRM);
    assert.equal(typeof SessionState.AWAITING_DESFAZER_CONFIRM, 'string');
  });
});