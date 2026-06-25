import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, clearCollections } from '../helpers/setup.js';
import { createTestContext } from '../helpers/context-factory.js';
import { handleMeusdados, handleApagar, handleAwaitingApagarConfirm, handleDesfazer, handleAwaitingDesfazerConfirm, handleExportar, MAX_WHATSAPP_CHARS } from '../../lib/commands.js';
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
    ctx.sessions.set(ctx.sessionKey, ctx.session);

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
    ctx.sessions.set(ctx.sessionKey, ctx.session);

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
    ctx.sessions.set(ctx.sessionKey, ctx.session);

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

  it('/exportar json emits VALID parseable JSON within the message limit', async () => {
    const uh = TEST_USER_HASH;
    // Insert enough transactions (with long descriptions) that the full JSON
    // would exceed MAX_WHATSAPP_CHARS, forcing the budget-fit path.
    const docs = [];
    for (let i = 0; i < 60; i++) {
      docs.push({
        user_hash: uh, type: i % 2 ? 'income' : 'expense', amount: 1000 + i,
        description: 'compra grande descricao '.repeat(3),
        date: new Date(Date.now() - i * 1000), message_sid: 'SM_ex_' + i
      });
    }
    await transactions.insertMany(docs);

    const { ctx, messages } = createTestContext({ transactions, debts, events, db });
    ctx.text = '/exportar json';

    await handleExportar(ctx);

    assert.ok(messages.length > 0, 'should reply');
    const body = messages[messages.length - 1].body;
    assert.ok(body.length <= MAX_WHATSAPP_CHARS, `JSON must fit limit, got ${body.length}`);

    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(body); }, 'JSON export must be valid (not truncated)');
    assert.equal(parsed.totals.transaction_count, 60, 'totals.transaction_count must reflect the REAL total');
    assert.equal(parsed._complete, false, 'partial export must be flagged _complete:false');
    assert.ok(parsed.transactions.length < 30, 'transactions array must be trimmed to fit (30 would not fit)');
  });

  it('/desfazer after /pago REOPENS the settled debt instead of deleting it', async () => {
    const uh = TEST_USER_HASH;
    const settled = await debts.insertOne({
      user_hash: uh, type: 'recebido', creditor: 'user', debtor: 'João',
      creditor_lower: 'user', debtor_lower: 'joão', amount: 2000,
      description: 'test', date: new Date(Date.now() - 60000), settled: true,
      settled_date: new Date(), message_sid: 'SM_reopen_1'
    });

    const { ctx, messages } = createTestContext({ transactions, debts, events, db });
    ctx.text = '/desfazer';
    await handleDesfazer(ctx);

    assert.equal(ctx.sessions.get(ctx.sessionKey).state, SessionState.AWAITING_DESFAZER_CONFIRM);
    const pending = ctx.sessions.get(ctx.sessionKey).pendingDesfazer;
    assert.equal(pending.type, 'debt_reopen', 'should offer to reopen, not delete');
    assert.equal(String(pending.id), String(settled.insertedId));

    // Sync ctx.session with the map (the webhook re-reads the session each request)
    ctx.session = ctx.sessions.get(ctx.sessionKey);
    ctx.text = 'sim';
    await handleAwaitingDesfazerConfirm(ctx);

    const doc = await debts.findOne({ _id: settled.insertedId });
    assert.ok(doc, 'debt must still exist (reopened, not deleted)');
    assert.equal(doc.settled, false);
    assert.equal(doc.settled_date, null);
    assert.ok(messages.some(m => m.body.includes('reaberta')));
  });

  it('/desfazer targets the newest action — a new transaction beats an older settled debt', async () => {
    const uh = TEST_USER_HASH;
    await debts.insertOne({
      user_hash: uh, type: 'recebido', creditor: 'user', debtor: 'João',
      creditor_lower: 'user', debtor_lower: 'joão', amount: 2000,
      description: 'test', date: new Date(Date.now() - 120000), settled: true,
      settled_date: new Date(Date.now() - 60000), message_sid: 'SM_prec_1'
    });
    await transactions.insertOne({
      user_hash: uh, type: 'income', amount: 5000, description: 'pao',
      date: new Date(), message_sid: 'SM_prec_2'
    });

    const { ctx } = createTestContext({ transactions, debts, events, db });
    ctx.text = '/desfazer';
    await handleDesfazer(ctx);

    const pending = ctx.sessions.get(ctx.sessionKey).pendingDesfazer;
    assert.equal(pending.type, 'transaction', 'newer transaction should be the undo target');
  });

  it('/desfazer deletes the most recent unsettled debt', async () => {
    const uh = TEST_USER_HASH;
    await debts.insertOne({
      user_hash: uh, type: 'recebido', creditor: 'user', debtor: 'João',
      creditor_lower: 'user', debtor_lower: 'joão', amount: 2000,
      description: 'test', date: new Date(), settled: false, settled_date: null,
      message_sid: 'SM_des_debt_1'
    });

    const { ctx, messages } = createTestContext({ transactions, debts, events, db });
    ctx.text = '/desfazer';
    await handleDesfazer(ctx);

    const pending = ctx.sessions.get(ctx.sessionKey).pendingDesfazer;
    assert.equal(pending.type, 'debt');

    // Sync ctx.session with the map (the webhook re-reads the session each request)
    ctx.session = ctx.sessions.get(ctx.sessionKey);
    ctx.text = 'sim';
    await handleAwaitingDesfazerConfirm(ctx);

    const count = await debts.countDocuments({ user_hash: uh });
    assert.equal(count, 0, 'unsettled debt should be deleted on confirm');
    assert.ok(messages.some(m => m.body.includes('apagado')));
  });
});