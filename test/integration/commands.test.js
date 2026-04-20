import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, clearCollections } from '../helpers/setup.js';
import { createTestContext } from '../helpers/context-factory.js';
import { handleMeusdados, handleApagar, handleAwaitingApagarConfirm, handleDesfazer, handleAwaitingDesfazerConfirm } from '../../lib/commands.js';
import { SessionState, hashPhone } from '../../lib/security.js';

const TEST_PHONE = 'whatsapp:+244912345678';
const TEST_USER_HASH = hashPhone(TEST_PHONE);

let db, transactions, debts, events, rateLimits, mongoClient;

describe('Commands Integration Tests', () => {
  beforeEach(async () => {
    const setup = await startMongo();
    db = setup.db;
    mongoClient = setup.client;
    transactions = db.collection('transactions');
    debts = db.collection('debts');
    events = db.collection('events');
    rateLimits = db.collection('rate_limits');
  });

  afterEach(async () => {
    await clearCollections();
    await stopMongo();
  });

  it('/meusdados masks phone number showing only last 4 digits', async () => {
    // Insert test data
    await transactions.insertOne({
      user_hash: TEST_USER_HASH, type: 'income', amount: 5000,
      description: 'pao', date: new Date(), message_sid: 'SM_md_1'
    });

    const { ctx, messages } = createTestContext({ transactions, debts, events, rateLimits, db });
    ctx.text = '/meusdados';

    await handleMeusdados(ctx);

    assert.ok(messages.length > 0);
    const body = messages[0].body;
    // Phone should be masked — only last 4 digits visible
    assert.ok(body.includes('5678'), 'Should show last 4 digits');
    assert.ok(!body.includes('+244912345678'), 'Should not show raw phone number');
    assert.ok(!body.includes('244912'), 'Should not show country code + number');
  });

  it('/apagar + sim deletes all user data atomically', async () => {
    const uh = TEST_USER_HASH;

    // Insert test data across collections
    await transactions.insertOne({
      user_hash: uh, type: 'income', amount: 5000,
      description: 'pao', date: new Date(), message_sid: 'SM_ap_1'
    });
    await debts.insertOne({
      user_hash: uh, type: 'recebido', creditor: 'user', debtor: 'João',
      creditor_lower: 'user', debtor_lower: 'joão', amount: 2000,
      description: 'test', date: new Date(), settled: false,
      settled_date: null, message_sid: 'SM_ap_2'
    });
    await events.insertOne({
      event_name: 'test', user_hash: uh, timestamp: new Date()
    });

    const { ctx, messages } = createTestContext({ transactions, debts, events, rateLimits, db, mongoClient });
    ctx.text = 'sim';
    ctx.session = { state: SessionState.AWAITING_APAGAR_CONFIRM };
    ctx.sessions[ctx.sessionKey] = ctx.session;

    await handleAwaitingApagarConfirm(ctx);

    // Verify all data is deleted
    const txCount = await transactions.countDocuments({ user_hash: uh });
    const debtCount = await debts.countDocuments({ user_hash: uh });
    const eventCount = await events.countDocuments({ user_hash: uh });
    assert.equal(txCount, 0);
    assert.equal(debtCount, 0);
    assert.equal(eventCount, 0);
    assert.ok(messages.some(m => m.body.includes('apagados')));
  });

  it('/apagar + nao keeps data intact', async () => {
    const uh = TEST_USER_HASH;

    await transactions.insertOne({
      user_hash: uh, type: 'income', amount: 5000,
      description: 'pao', date: new Date(), message_sid: 'SM_ap_3'
    });

    const { ctx, messages } = createTestContext({ transactions, debts, events, rateLimits, db });
    ctx.text = 'nao';
    ctx.session = { state: SessionState.AWAITING_APAGAR_CONFIRM };
    ctx.sessions[ctx.sessionKey] = ctx.session;

    await handleAwaitingApagarConfirm(ctx);

    const txCount = await transactions.countDocuments({ user_hash: uh });
    assert.equal(txCount, 1);
    assert.ok(messages.some(m => m.body.includes('cancelada')));
  });

  it('/desfazer + sim deletes last record', async () => {
    const uh = TEST_USER_HASH;

    const inserted = await transactions.insertOne({
      user_hash: uh, type: 'income', amount: 5000,
      description: 'pao', date: new Date(), message_sid: 'SM_des_1'
    });

    const { ctx, messages } = createTestContext({ transactions, debts, events, db });
    ctx.text = 'sim';
    ctx.session = {
      state: SessionState.AWAITING_DESFAZER_CONFIRM,
      pendingDesfazer: { type: 'transaction', id: inserted.insertedId, detail: 'entrada de 5 000,00 Kz' }
    };
    ctx.sessions[ctx.sessionKey] = ctx.session;

    await handleAwaitingDesfazerConfirm(ctx);

    const txCount = await transactions.countDocuments({ user_hash: uh });
    assert.equal(txCount, 0);
    assert.ok(messages.some(m => m.body.includes('Desfeito')));
  });

  it('/desfazer when no records shows message', async () => {
    const { ctx, messages } = createTestContext({ transactions, debts, events, db });
    ctx.text = '/desfazer';

    await handleDesfazer(ctx);

    assert.ok(messages.some(m => m.body.includes('Não tens registos')));
  });
});