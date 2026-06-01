#!/usr/bin/env node
/**
 * CivicLens WhatsApp Agent (Baileys)
 * No browser required. QR code prints directly in terminal.
 *
 * Usage: npx tsx agents/whatsapp.ts
 */

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeInMemoryStore,
  proto,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import pino from 'pino';

import { ROOT, PIPE_DIR, STUB_PATH, AUTH_DIR } from '../lib/paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Pipeline helpers ─────────────────────────────────────────────────────────

function findCachedTask(name: string, maxAgeMs = 24 * 60 * 60 * 1000): string | null {
  if (!fs.existsSync(PIPE_DIR)) return null;
  const dirs = fs.readdirSync(PIPE_DIR).sort().reverse();
  for (const taskId of dirs) {
    const statePath = path.join(PIPE_DIR, taskId, 'state.json');
    const finalPath = path.join(PIPE_DIR, taskId, 'final-review.json');
    if (!fs.existsSync(statePath) || !fs.existsSync(finalPath)) continue;
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    const final = JSON.parse(fs.readFileSync(finalPath, 'utf-8'));
    if (state.target?.name?.toLowerCase() !== name.toLowerCase()) continue;
    if (!final.readyToApply) continue;
    const age = Date.now() - new Date(state.updatedAt).getTime();
    if (age < maxAgeMs) return taskId;
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

  lines.push(`*${sum.headline}*`);
  lines.push('');
  lines.push(sum.bio ?? '');

  if (sum.keyFacts?.length) {
    lines.push('');
    lines.push('*Key Facts*');
    for (const fact of sum.keyFacts) lines.push(`• ${fact}`);
  }

  if (sum.neutralNarrative) {
    lines.push('');
    lines.push('*Overview*');
    lines.push(sum.neutralNarrative);
  }

  if (d?.controversies?.length) {
    lines.push('');
    lines.push(`*Controversies:* ${d.controversies.length} on record`);
  }

  if (d?.donors?.length) {
    const top = d.donors[0];
    const amt = top.amount >= 1e6
      ? `$${(top.amount / 1e6).toFixed(1)}M`
      : `$${(top.amount / 1e3).toFixed(0)}K`;
    lines.push(`*Top donor:* ${top.name} (${amt})`);
  }

  lines.push('');
  lines.push(`_CivicLens · ${new Date().toLocaleDateString()}_`);
  return lines.join('\n');
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
  if (words.length >= 2 && /^[a-zA-Z\s\-'\.]+$/.test(text) && text.length >= 4) {
    return words.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  }
  return null;
}

function getListText(): string {
  if (!fs.existsSync(STUB_PATH)) return 'No politician data found.';
  const stub = JSON.parse(fs.readFileSync(STUB_PATH, 'utf-8'));
  const names = (stub.politicians ?? []).map((p: any) => `• ${p.name} (${p.role})`);
  return `*Available Politicians*\n\n${names.join('\n')}\n\n_Send any name to get their profile._`;
}

const HELP = `*CivicLens* — Political Transparency Bot

Send a politician name to get their profile:
  _Donald Trump_
  _Alexandria Ocasio-Cortez_
  _Elon Musk_

Commands:
  *help* — this message
  *list* — available politicians

Powered by OpenClaw pipeline.`;

// ─── WhatsApp via Baileys ─────────────────────────────────────────────────────

const pending = new Set<string>();

async function startBot() {
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }), // suppress noisy logs
    printQRInTerminal: true,            // Baileys prints QR natively
    browser: ['CivicLens', 'Chrome', '1.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.clear();
      console.log('\n CivicLens WhatsApp Agent\n');
      console.log(' Scan this QR with WhatsApp → Linked Devices → Link a Device\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      console.clear();
      console.log('\n ✓ WhatsApp connected — CivicLens bot is live');
      console.log(' Message any politician name to get their profile.\n');
    }

    if (connection === 'close') {
      const code = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log(`Connection closed (${code}). Reconnecting: ${shouldReconnect}`);
      if (shouldReconnect) startBot();
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const jid  = msg.key.remoteJid!;
      const text = (
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        ''
      ).trim();

      if (!text) continue;

      const lower = text.toLowerCase();

      const reply = async (body: string) => {
        await sock.sendMessage(jid, { text: body }, { quoted: msg });
      };

      if (lower === 'help' || lower === '/help') {
        await reply(HELP);
        continue;
      }

      if (lower === 'list' || lower === '/list') {
        await reply(getListText());
        continue;
      }

      const name = normalizeName(text);
      if (!name) {
        await reply(`Didn't recognise that as a politician name.\n\nSend *help* for usage or *list* for options.`);
        continue;
      }

      const cached = findCachedTask(name);
      if (cached) {
        await reply(formatSummary(cached));
        continue;
      }

      if (pending.has(name.toLowerCase())) {
        await reply(`Already running pipeline for ${name}. Please wait…`);
        continue;
      }

      await reply(`_Running OpenClaw pipeline for *${name}*…\nThis takes 1–3 minutes. I'll reply when done._`);
      pending.add(name.toLowerCase());

      try {
        runPipeline(name);
        const taskId = findCachedTask(name);
        await reply(taskId ? formatSummary(taskId) : `Pipeline ran but no approved result found for ${name}.`);
      } catch (e: any) {
        await reply(`Pipeline failed for ${name}: ${e.message.slice(0, 200)}`);
      } finally {
        pending.delete(name.toLowerCase());
      }
    }
  });
}

startBot().catch(console.error);
