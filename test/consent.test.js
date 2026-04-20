import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SessionState, OnboardingState } from '../lib/security.js';

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

  // Integration tests for consent/onboarding flow are in test/integration/onboarding.test.js
});