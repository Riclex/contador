import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, clearCollections } from '../helpers/setup.js';
import { createTestContext } from '../helpers/context-factory.js';
import { handleAwaitingConfirmation, handleHoje } from '../../lib/commands.js';
import { SessionState, hashPhone } from '../../lib/security.js';

const TEST_PHONE = 'whatsapp:+244912345678';
const TEST_USER_HASH = hashPhone(TEST_PHONE);

let db, transactions, debts, events;

describe('Transaction Integration Tests', () => {
  beforeEach(async () => {
    const setup = await startMongo();
    db = setup.db;
    transactions = db.collection('transactions');
    debts = db.collection('debts');
    events = db.collection('events');
  });

  afterEach(async () => {
    await clearCollections();
    await stopMongo();
  });

  it('AWAITING_CONFIRMATION + "sim" confirms and inserts transaction', async () => {
    const { ctx, messages } = createTestContext({ transactions, debts, events, db });
    ctx.text = 'sim';
    ctx.session = {
      state: SessionState.AWAITING_CONFIRMATION,
      pending: { type: 'income', amount: 5000, description: 'pao' }
    };
    ctx.sessions[ctx.sessionKey] = ctx.session;

    await handleAwaitingConfirmation(ctx);

    const docs = await transactions.find({ user_hash: ctx.userHash }).toArray();
    assert.equal(docs.length, 1);
    assert.equal(docs[0].type, 'income');
    assert.equal(docs[0].amount, 5000);
    assert.equal(docs[0].description, 'pao');
    assert.ok(messages.some(m => m.body.includes('Registado')));
    assert.equal(ctx.sessions[ctx.sessionKey].state, SessionState.IDLE);
  });

  it('AWAITING_CONFIRMATION + "nao" cancels without inserting', async () => {
    const { ctx, messages } = createTestContext({ transactions, debts, events, db });
    ctx.text = 'nao';
    ctx.session = {
      state: SessionState.AWAITING_CONFIRMATION,
      pending: { type: 'expense', amount: 1000, description: 'saldo' }
    };
    ctx.sessions[ctx.sessionKey] = ctx.session;

    await handleAwaitingConfirmation(ctx);

    const docs = await transactions.find({ user_hash: ctx.userHash }).toArray();
    assert.equal(docs.length, 0);
    assert.ok(messages.some(m => m.body.includes('Cancelado')));
    assert.equal(ctx.sessions[ctx.sessionKey].state, SessionState.IDLE);
  });

  it('AWAITING_CONFIRMATION + unrecognized text asks for clarification', async () => {
    const { ctx, messages } = createTestContext({ transactions, debts, events, db });
    ctx.text = 'vendi 5000';
    ctx.session = {
      state: SessionState.AWAITING_CONFIRMATION,
      pending: { type: 'income', amount: 5000, description: 'test' }
    };
    ctx.sessions[ctx.sessionKey] = ctx.session;

    await handleAwaitingConfirmation(ctx);

    const docs = await transactions.find({ user_hash: ctx.userHash }).toArray();
    assert.equal(docs.length, 0);
    assert.ok(messages.some(m => m.body.includes('Sim ou Não')));
  });

  it('AWAITING_CONFIRMATION rejects invalid amount (NaN)', async () => {
    const { ctx, messages } = createTestContext({ transactions, debts, events, db });
    ctx.text = 'sim';
    ctx.session = {
      state: SessionState.AWAITING_CONFIRMATION,
      pending: { type: 'income', amount: NaN, description: 'test' }
    };
    ctx.sessions[ctx.sessionKey] = ctx.session;

    await handleAwaitingConfirmation(ctx);

    const docs = await transactions.find({ user_hash: ctx.userHash }).toArray();
    assert.equal(docs.length, 0);
    assert.ok(messages.some(m => m.body.includes('inválido')));
    assert.equal(ctx.sessions[ctx.sessionKey].state, SessionState.IDLE);
  });

  it('hoje shows correct daily total', async () => {
    await transactions.insertMany([
      { user_hash: TEST_USER_HASH, type: 'income', amount: 5000, description: 'pao', date: new Date(), message_sid: 'SM_hoje_1' },
      { user_hash: TEST_USER_HASH, type: 'expense', amount: 2000, description: 'saldo', date: new Date(), message_sid: 'SM_hoje_2' },
    ]);

    const { ctx, messages } = createTestContext({ transactions, debts, events, db });
    ctx.text = 'hoje';

    await handleHoje(ctx);

    assert.ok(messages.length > 0);
    assert.ok(messages[0].body.includes('3 000,00'));
  });
});