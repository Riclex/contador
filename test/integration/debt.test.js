import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, clearCollections } from '../helpers/setup.js';
import { createTestContext } from '../helpers/context-factory.js';
import { handleAwaitingDebtConfirmation, handleAwaitingPagoConfirm, handleAwaitingDebtorName, handlePago } from '../../lib/commands.js';
import { SessionState, hashPhone } from '../../lib/security.js';

const TEST_PHONE = 'whatsapp:+244912345678';
const TEST_USER_HASH = hashPhone(TEST_PHONE);

let db, transactions, debts, events;

describe('Debt Integration Tests', () => {
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

  it('AWAITING_DEBT_CONFIRMATION + "sim" confirms and inserts debt', async () => {
    const { ctx, messages } = createTestContext({ transactions, debts, events, db });
    ctx.text = 'sim';
    ctx.session = {
      state: SessionState.AWAITING_DEBT_CONFIRMATION,
      pendingDebt: { type: 'recebido', creditor: 'user', debtor: 'João', amount: 2000, description: 'test' }
    };
    ctx.sessions[ctx.sessionKey] = ctx.session;

    await handleAwaitingDebtConfirmation(ctx);

    const docs = await debts.find({ user_hash: ctx.userHash }).toArray();
    assert.equal(docs.length, 1);
    assert.equal(docs[0].type, 'recebido');
    assert.equal(docs[0].debtor, 'João');
    assert.equal(docs[0].amount, 2000);
    assert.equal(docs[0].settled, false);
    assert.ok(messages.some(m => m.body.includes('Dívida registada') || m.body.includes('Registado')));
    assert.equal(ctx.sessions[ctx.sessionKey].state, SessionState.IDLE);
  });

  it('AWAITING_DEBT_CONFIRMATION + "nao" cancels without inserting', async () => {
    const { ctx, messages } = createTestContext({ transactions, debts, events, db });
    ctx.text = 'nao';
    ctx.session = {
      state: SessionState.AWAITING_DEBT_CONFIRMATION,
      pendingDebt: { type: 'devido', creditor: 'Maria', debtor: 'user', amount: 1500, description: 'test' }
    };
    ctx.sessions[ctx.sessionKey] = ctx.session;

    await handleAwaitingDebtConfirmation(ctx);

    const docs = await debts.find({ user_hash: ctx.userHash }).toArray();
    assert.equal(docs.length, 0);
    assert.ok(messages.some(m => m.body.includes('Cancelado')));
  });

  it('/pago + sim marks debt as settled', async () => {
    // Insert a debt first
    await debts.insertOne({
      user_hash: TEST_USER_HASH,
      type: 'recebido',
      creditor: 'user',
      debtor: 'João',
      creditor_lower: 'user',
      debtor_lower: 'joão',
      amount: 2000,
      description: 'test',
      date: new Date(),
      settled: false,
      settled_date: null,
      message_sid: 'SM_pago_1'
    });

    const { ctx, messages } = createTestContext({ transactions, debts, events, db });
    ctx.session = {
      state: SessionState.AWAITING_PAGO_CONFIRM,
      pendingPago: {
        debtId: (await debts.findOne({ user_hash: TEST_USER_HASH }))._id,
        name: 'João',
        type: 'recebido',
        debtor: 'João',
        creditor: 'user',
        amount: 2000
      }
    };
    ctx.sessions[ctx.sessionKey] = ctx.session;
    ctx.text = 'sim';

    await handleAwaitingPagoConfirm(ctx);

    const doc = await debts.findOne({ user_hash: TEST_USER_HASH });
    assert.equal(doc.settled, true);
    assert.ok(doc.settled_date);
    assert.ok(messages.some(m => m.body.includes('paga')));
    assert.equal(ctx.sessions[ctx.sessionKey].state, SessionState.IDLE);
  });

  it('AWAITING_DEBTOR_NAME with valid name transitions to confirmation', async () => {
    const { ctx, messages } = createTestContext({ transactions, debts, events, db });
    ctx.text = 'Maria';
    ctx.session = {
      state: SessionState.AWAITING_DEBTOR_NAME,
      pendingDebt: { type: 'recebido', creditor: 'user', debtor: 'user', amount: 3000, description: 'test' }
    };
    ctx.sessions[ctx.sessionKey] = ctx.session;

    await handleAwaitingDebtorName(ctx);

    assert.equal(ctx.sessions[ctx.sessionKey].state, SessionState.AWAITING_DEBT_CONFIRMATION);
    assert.equal(ctx.sessions[ctx.sessionKey].pendingDebt.debtor, 'Maria');
    assert.ok(messages.some(m => m.body.includes('Sim ou Não')));
  });

  it('AWAITING_DEBTOR_NAME rejects reserved word "sim"', async () => {
    const { ctx, messages } = createTestContext({ transactions, debts, events, db });
    ctx.text = 'sim';
    ctx.session = {
      state: SessionState.AWAITING_DEBTOR_NAME,
      pendingDebt: { type: 'recebido', creditor: 'user', debtor: 'user', amount: 3000, description: 'test' }
    };
    ctx.sessions[ctx.sessionKey] = ctx.session;

    await handleAwaitingDebtorName(ctx);

    assert.equal(ctx.sessions[ctx.sessionKey].state, SessionState.IDLE);
    assert.ok(messages.some(m => m.body.includes('inválido') || m.body.includes('Nome')));
  });

  it('/pago shows extra debt count in confirmation prompt', async () => {
    // Insert two debts with same name
    await debts.insertMany([
      {
        user_hash: TEST_USER_HASH, type: 'recebido', creditor: 'user', debtor: 'João',
        creditor_lower: 'user', debtor_lower: 'joão', amount: 2000, description: 'test1',
        date: new Date(), settled: false, settled_date: null, message_sid: 'SM_pago_e1'
      },
      {
        user_hash: TEST_USER_HASH, type: 'recebido', creditor: 'user', debtor: 'João',
        creditor_lower: 'user', debtor_lower: 'joão', amount: 3000, description: 'test2',
        date: new Date(), settled: false, settled_date: null, message_sid: 'SM_pago_e2'
      }
    ]);

    const { ctx, messages } = createTestContext({ transactions, debts, events, db });
    ctx.text = '/pago João';

    await handlePago(ctx, 'João');

    assert.ok(messages.some(m => m.body.includes('mais 1 dívida')));
    assert.equal(ctx.sessions[ctx.sessionKey].state, SessionState.AWAITING_PAGO_CONFIRM);
  });
});