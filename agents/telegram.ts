#!/usr/bin/env node
/**
 * CivicLens Telegram Bot
 * Usage: BOT_TOKEN=<token> npx tsx agents/telegram.ts
 */

import { Telegraf, Context } from 'telegraf';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

import { ROOT, PIPE_DIR, STUB_PATH } from '../lib/paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  console.error('Missing BOT_TOKEN. Run: BOT_TOKEN=<token> npx tsx agents/telegram.ts');
  process.exit(1);
}

// ─── Pipeline helpers ─────────────────────────────────────────────────────────

function findFreshTask(name: string, maxAgeMs = 24 * 60 * 60 * 1000): string | null {
  if (!fs.existsSync(PIPE_DIR)) return null;
  const dirs = fs.readdirSync(PIPE_DIR).sort().reverse();
  for (const taskId of dirs) {
    const stateFile = path.join(PIPE_DIR, taskId, 'state.json');
    const finalFile = path.join(PIPE_DIR, taskId, 'final-review.json');
    if (!fs.existsSync(stateFile) || !fs.existsSync(finalFile)) continue;
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    const final = JSON.parse(fs.readFileSync(finalFile, 'utf-8'));
    if (state.target?.name?.toLowerCase() !== name.toLowerCase()) continue;
    if (!final.readyToApply) continue;
    if (Date.now() - new Date(state.updatedAt).getTime() < maxAgeMs) return taskId;
  }
  return null;
}

function formatSummary(taskId: string): string {
  const sumPath = path.join(PIPE_DIR, taskId, 'summarizer.json');
  const resPath = path.join(PIPE_DIR, taskId, 'researcher.json');
  if (!fs.existsSync(sumPath)) return 'Summary not available.';

  const sum = JSON.parse(fs.readFileSync(sumPath, 'utf-8'));
  const res = fs.existsSync(resPath) ? JSON.parse(fs.readFileSync(resPath, 'utf-8')) : null;
  const d   = res?.data;
  const lines: string[] = [];

  lines.push(`<b>${escHtml(sum.headline ?? '')}</b>`);
  lines.push('');
  lines.push(escHtml(sum.bio ?? ''));

  if (sum.keyFacts?.length) {
    lines.push('');
    lines.push('<b>Key Facts</b>');
    for (const f of sum.keyFacts) lines.push(`• ${escHtml(f)}`);
  }

  if (sum.neutralNarrative) {
    lines.push('');
    lines.push('<b>Overview</b>');
    lines.push(escHtml(sum.neutralNarrative));
  }

  if (d?.controversies?.length) {
    lines.push('');
    lines.push(`<b>Controversies:</b> ${d.controversies.length} on record`);
  }

  if (d?.donors?.length) {
    const top = d.donors[0];
    const amt = top.amount >= 1e6
      ? `$${(top.amount / 1e6).toFixed(1)}M`
      : `$${(top.amount / 1e3).toFixed(0)}K`;
    lines.push(`<b>Top donor:</b> ${escHtml(top.name)} (${amt})`);
  }

  if (sum.dataQualityNote && sum.dataQualityNote !== 'Data passed full validation.') {
    lines.push('');
    lines.push(`<i>⚠ ${escHtml(sum.dataQualityNote)}</i>`);
  }

  lines.push('');
  lines.push(`<i>CivicLens · ${new Date().toLocaleDateString()}</i>`);
  return lines.join('\n');
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function runPipeline(name: string): void {
  const result = spawnSync(
    'npx', ['tsx', path.join(__dirname, 'pipeline.ts'), name],
    { encoding: 'utf8', timeout: 600_000, cwd: ROOT }
  );
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'Pipeline failed');
}

function normalizeName(input: string): string | null {
  const text = input.trim();
  if (fs.existsSync(STUB_PATH)) {
    const stub = JSON.parse(fs.readFileSync(STUB_PATH, 'utf-8'));
    const match = (stub.politicians ?? []).find((p: any) =>
      p.name.toLowerCase().includes(text.toLowerCase()) ||
      text.toLowerCase().includes(p.name.toLowerCase().split(' ').slice(-1)[0])
    );
    if (match) return match.name;
  }
  const words = text.split(/\s+/);
  if (words.length >= 2 && /^[a-zA-Z\s\-'\.]+$/.test(text)) {
    return words.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  }
  return null;
}

function listPoliticians(): string {
  if (!fs.existsSync(STUB_PATH)) return 'No stub data found.';
  const stub = JSON.parse(fs.readFileSync(STUB_PATH, 'utf-8'));
  return (stub.politicians ?? [])
    .map((p: any) => `• ${p.name} — ${p.role}`)
    .join('\n');
}

function listTasks(): string {
  if (!fs.existsSync(PIPE_DIR)) return 'No tasks run yet.';
  const dirs = fs.readdirSync(PIPE_DIR)
    .filter(f => fs.existsSync(path.join(PIPE_DIR, f, 'state.json')))
    .sort().reverse().slice(0, 10);
  if (!dirs.length) return 'No tasks run yet.';
  return dirs.map(taskId => {
    const state = JSON.parse(fs.readFileSync(path.join(PIPE_DIR, taskId, 'state.json'), 'utf-8'));
    const finalPath = path.join(PIPE_DIR, taskId, 'final-review.json');
    const decision = fs.existsSync(finalPath)
      ? JSON.parse(fs.readFileSync(finalPath, 'utf-8')).decision
      : state.status;
    const age = Math.floor((Date.now() - new Date(state.updatedAt).getTime()) / 60000);
    const ageStr = age < 60 ? `${age}m ago` : `${Math.floor(age / 60)}h ago`;
    return `• ${state.target.name} — ${decision} (${ageStr})`;
  }).join('\n');
}

// ─── Bot ─────────────────────────────────────────────────────────────────────

const bot = new Telegraf(TOKEN);
const pending = new Set<string>();

bot.start((ctx) => ctx.replyWithHTML(
  `<b>CivicLens</b> — Political Transparency\n\n` +
  `Send any politician name to get their profile.\n\n` +
  `<b>Commands:</b>\n` +
  `/list — available politicians\n` +
  `/tasks — recent pipeline runs\n` +
  `/help — show this message`
));

bot.help((ctx) => ctx.replyWithHTML(
  `<b>Commands:</b>\n/list — politicians\n/tasks — recent runs\n\n` +
  `Or just send a name: <i>Donald Trump</i>`
));

bot.command('list', (ctx) => ctx.reply(listPoliticians()));

bot.command('tasks', (ctx) => ctx.reply(listTasks()));

bot.on('text', async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith('/')) return;

  const name = normalizeName(text);
  if (!name) {
    await ctx.reply(`Didn't recognise that as a politician name.\n\nTry /list for options.`);
    return;
  }

  // Cache check
  const cached = findFreshTask(name);
  if (cached) {
    await ctx.replyWithHTML(formatSummary(cached));
    return;
  }

  if (pending.has(name.toLowerCase())) {
    await ctx.reply(`Already running pipeline for ${name}. Please wait…`);
    return;
  }

  const thinking = await ctx.reply(`Running OpenClaw pipeline for ${name}…\nThis takes 1–3 minutes.`);
  pending.add(name.toLowerCase());

  try {
    runPipeline(name);
    const taskId = findFreshTask(name, Infinity); // any age — just ran
    if (taskId) {
      await ctx.replyWithHTML(formatSummary(taskId));
    } else {
      await ctx.reply(`Pipeline ran but no approved result found for ${name}.`);
    }
  } catch (e: any) {
    await ctx.reply(`Pipeline failed: ${e.message.slice(0, 200)}`);
  } finally {
    pending.delete(name.toLowerCase());
  }
});

bot.launch();
console.log('✓ CivicLens Telegram bot is live');

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
