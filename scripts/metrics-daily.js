#!/usr/bin/env node
/**
 * Daily Metrics Extraction & Backfill for Contador
 * Computes daily metrics and stores them in the daily_metrics collection.
 * Also outputs CSV format for Google Sheets import.
 *
 * Usage:
 *   node scripts/metrics-daily.js                      # Today's metrics (compute + store)
 *   node scripts/metrics-daily.js --date 2026-04-20   # Specific date
 *   node scripts/metrics-daily.js --days 7            # Last 7 days
 *   node scripts/metrics-daily.js --backfill          # Backfill missing days
 *   node scripts/metrics-daily.js --backfill --days 90  # Backfill last 90 days
 */

import "dotenv/config";
import { MongoClient } from "mongodb";
import { computeDailyMetrics, getAngolaDateStr } from '../lib/metrics.js';

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error("Error: MONGODB_URI not set in .env");
  process.exit(1);
}

// Parse command line args
const args = process.argv.slice(2);
let targetDate = new Date();
let days = 1;
let backfill = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--date" && args[i + 1]) {
    targetDate = new Date(args[i + 1]);
    i++;
  } else if (args[i] === "--days" && args[i + 1]) {
    days = parseInt(args[i + 1], 10);
    i++;
  } else if (args[i] === "--backfill") {
    backfill = true;
  }
}

async function storeSnapshot(dailyMetrics, metrics) {
  try {
    await dailyMetrics.replaceOne(
      { _id: metrics.date },
      { ...metrics, _id: metrics.date },
      { upsert: true }
    );
  } catch (err) {
    if (err.code !== 11000) throw err;
  }
}

async function main() {
  const mongo = new MongoClient(MONGODB_URI);
  await mongo.connect();
  const db = mongo.db();
  const events = db.collection("events");
  const transactions = db.collection("transactions");
  const debts = db.collection("debts");
  const dailyMetrics = db.collection("daily_metrics");

  // CSV header
  console.log("date,new_users,active_users,returning_users,total_messages,confirmed_transactions,debts_created,total_income,total_expense,debts_settled,openai_calls,openai_cache_hits");

  for (let i = 0; i < days; i++) {
    const date = new Date(targetDate);
    date.setDate(date.getDate() - i);
    const dateStr = getAngolaDateStr(date);

    if (backfill) {
      // Check if snapshot already exists
      const existing = await dailyMetrics.findOne({ _id: dateStr });
      if (existing) {
        console.log(`# ${dateStr} already exists, skipping`);
        continue;
      }
    }

    const metrics = await computeDailyMetrics(events, transactions, debts, date);

    // Store in MongoDB
    await storeSnapshot(dailyMetrics, metrics);

    // CSV output
    console.log(
      `${metrics.date},${metrics.newUsers},${metrics.activeUsers},${metrics.returningUsers},${metrics.totalMessages},${metrics.confirmedTransactions},${metrics.debtsCreated},${metrics.totalIncome},${metrics.totalExpense},${metrics.debtsSettled},${metrics.openaiCalls},${metrics.openaiCacheHits}`
    );
  }

  await mongo.close();
}

main().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});