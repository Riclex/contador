import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext } from './helpers/context-factory.js';
import { handleDica } from '../lib/commands.js';
import { TIPS } from '../lib/tips.js';

describe('/dica', () => {
  it('replies with a non-empty tip and logs command_used/dica', async () => {
    const { ctx, messages, events } = createTestContext();
    await handleDica(ctx);

    assert.equal(messages.length, 1, 'sends exactly one reply');
    assert.ok(messages[0].body.length > 10, 'tip body is non-empty');
    assert.deepEqual(
      events[0],
      { eventName: 'command_used', metadata: { command: 'dica' } },
      'logs the command_used event with command: dica'
    );
  });

  it('returns a tip that exists in the library (stable over many calls)', async () => {
    const tipTexts = new Set(TIPS.map(t => t.text));
    for (let i = 0; i < 20; i++) {
      const { ctx, messages } = createTestContext();
      await handleDica(ctx);
      const body = messages[0].body.replace(/^\u{1F4A1} Dica: /u, '');
      assert.ok(tipTexts.has(body), `reply text matches a library tip: "${body.slice(0, 40)}..."`);
    }
  });
});