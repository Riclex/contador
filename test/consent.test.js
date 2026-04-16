import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SessionState, OnboardingState } from '../index.js';

describe('Consent Flow (Lei 22/11)', () => {

  describe('Onboarding state values are valid and consistent', () => {
    it('OnboardingState.AWAITING_CONSENT is a string', () => {
      assert.equal(typeof OnboardingState.AWAITING_CONSENT, 'string');
    });

    it('OnboardingState.COMPLETED is a string', () => {
      assert.equal(typeof OnboardingState.COMPLETED, 'string');
    });

    it('AWAITING_CONSENT and COMPLETED are distinct values', () => {
      assert.notEqual(OnboardingState.AWAITING_CONSENT, OnboardingState.COMPLETED);
    });
  });

  describe('Session state values are valid', () => {
    it('SessionState.IDLE is a string', () => {
      assert.equal(typeof SessionState.IDLE, 'string');
    });

    it('all SessionState values are distinct', () => {
      const values = Object.values(SessionState);
      assert.equal(new Set(values).size, values.length);
    });
  });

  // --- Integration tests requiring running server ---
  // These cannot run in unit test mode because the consent flow
  // is embedded inside the webhook handler and depends on MongoDB.
  it.todo('first_use event logged only AFTER user responds "sim"');
  it.todo('non-consenting users (other input) generate no first_use event');
  it.todo('onboarding transitions: new user -> awaiting_consent -> completed');
  it.todo('rate limiting applies before consent check (non-consenting users still rate-limited)');
});