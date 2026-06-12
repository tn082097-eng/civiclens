/**
 * Shared infrastructure for all pipeline agents.
 *
 * Exports: logging, task I/O, LLM wrapper, env loading, skill loader,
 * neutrality checker, and all module-level constants.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import type { ZodTypeAny } from 'zod';
import type { PipelineTask, AgentName, PipelineStatus } from '../lib/types.js';
import * as paths from '../lib/paths.js';

export const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const HOME       = process.env.HOME!;
export const PIPE_DIR   = process.env.CIVICLENS_PIPE_DIR ?? paths.PIPE_DIR;
export const SKILLS_DIR = paths.SKILLS_DIR;

// ─── ANSI helpers ─────────────────────────────────────────────────────────────
export const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  red:    '\x1b[31m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  blue:   '\x1b[34m',
  cyan:   '\x1b[36m',
  gray:   '\x1b[90m',
};
export const bold   = (s: string) => `${c.bold}${s}${c.reset}`;
export const dim    = (s: string) => `${c.dim}${s}${c.reset}`;
export const red    = (s: string) => `${c.red}${s}${c.reset}`;
export const green  = (s: string) => `${c.green}${s}${c.reset}`;
export const yellow = (s: string) => `${c.yellow}${s}${c.reset}`;
export const cyan   = (s: string) => `${c.cyan}${s}${c.reset}`;
export const gray   = (s: string) => `${c.gray}${s}${c.reset}`;

export function header(title: string) {
  const line = '─'.repeat(58);
  console.log(`\n${c.cyan}${line}${c.reset}`);
  console.log(`${c.bold}${c.cyan}  ${title}${c.reset}`);
  console.log(`${c.cyan}${line}${c.reset}\n`);
}

function step(icon: string, name: string, detail = '') {
  const pad = name.padEnd(18);
  process.stdout.write(`  ${icon}  ${bold(pad)}  ${dim(detail)}\n`);
}

export function ok   (name: string, msg = '') { step(green('✓'), name, msg); }
export function fail (name: string, msg = '') { step(red('✗'),   name, msg); }
export function warn (name: string, msg = '') { step(yellow('⚠'), name, msg); }
export function info (name: string, msg = '') { step(cyan('›'),  name, msg); }
export function spin (name: string, msg = '') {
  process.stdout.write(`  ${cyan('⟳')}  ${bold(name.padEnd(18))}  ${dim(msg)}\r`);
}

// ─── Skill loader ─────────────────────────────────────────────────────────────
export function stripFrontmatter(md: string): string {
  if (!md.startsWith('---')) return md;
  const end = md.indexOf('\n---', 3);
  return end === -1 ? md : md.slice(end + 4).replace(/^\n/, '');
}

export function loadSkill(name: string): { systemPrompt: string; source: 'contract'|'skill'|'none' } {
  const contractPath = path.join(SKILLS_DIR, name, 'CONTRACT.md');
  const skillPath    = path.join(SKILLS_DIR, name, 'SKILL.md');
  if (fs.existsSync(contractPath)) {
    return { systemPrompt: fs.readFileSync(contractPath, 'utf-8'), source: 'contract' };
  }
  if (fs.existsSync(skillPath)) {
    return { systemPrompt: stripFrontmatter(fs.readFileSync(skillPath, 'utf-8')), source: 'skill' };
  }
  return { systemPrompt: '', source: 'none' };
}

// ─── Task state I/O ───────────────────────────────────────────────────────────
export function taskDir(taskId: string) { return path.join(PIPE_DIR, taskId); }
export function taskFile(taskId: string){ return path.join(taskDir(taskId), 'state.json'); }
export function pipeFile(taskId: string, name: string) {
  return path.join(taskDir(taskId), `${name}.json`);
}

export function readTask(taskId: string): PipelineTask {
  return JSON.parse(fs.readFileSync(taskFile(taskId), 'utf-8'));
}

export function writeTask(task: PipelineTask) {
  fs.mkdirSync(taskDir(task.taskId), { recursive: true });
  task.updatedAt = new Date().toISOString();
  fs.writeFileSync(taskFile(task.taskId), JSON.stringify(task, null, 2));
}

/**
 * Thrown when an artifact on disk fails its schema (PR 2 typed reads).
 * Optional-sidecar readers catch this and log a warning; required readers
 * let it propagate — a malformed required artifact must kill the run loudly.
 */
export class ArtifactValidationError extends Error {
  constructor(taskId: string, name: string, issues: { path: (string | number)[]; message: string }[]) {
    const first = issues[0];
    const field = first && first.path.length ? first.path.join('.') : '(root)';
    const more = issues.length > 1 ? ` (+${issues.length - 1} more issue${issues.length > 2 ? 's' : ''})` : '';
    super(`artifact validation failed: task=${taskId} agent=${name} field=${field} — ${first?.message ?? 'unknown'}${more}`);
    this.name = 'ArtifactValidationError';
  }
}

export function readPipe<T>(taskId: string, name: string, schema?: ZodTypeAny): T {
  const raw = JSON.parse(fs.readFileSync(pipeFile(taskId, name), 'utf-8'));
  if (schema) {
    const result = schema.safeParse(raw);
    if (!result.success) throw new ArtifactValidationError(taskId, name, result.error.issues);
  }
  // Raw on purpose, never result.data: Zod strips unknown keys and injects
  // .default() values; this is validation, not transformation (PR 2 plan,
  // scope decision 6).
  return raw as T;
}

export function writePipe(taskId: string, name: string, data: unknown) {
  fs.writeFileSync(pipeFile(taskId, name), JSON.stringify(data, null, 2));
}

export function initTask(taskId: string, targetName: string): PipelineTask {
  const def = { status: 'pending' as const, retries: 0 };
  const task: PipelineTask = {
    taskId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'initializing',
    target: { name: targetName, type: 'politician' },
    agents: {
      researcher:          { ...def },
      'data-checker':      { ...def },
      predictor:           { ...def },
      'trade-analyst':     { ...def },
      summarizer:          { ...def },
      'code-checker':      { ...def },
      'final-reviewer':    { ...def },
    },
  };
  fs.mkdirSync(taskDir(taskId), { recursive: true });
  writeTask(task);
  return task;
}

export function markAgent(
  task: PipelineTask, agent: AgentName,
  status: 'running'|'complete'|'failed'|'skipped', output?: unknown,
) {
  task.agents[agent] = {
    status,
    startedAt: task.agents[agent].startedAt ?? new Date().toISOString(),
    completedAt: status !== 'running' ? new Date().toISOString() : undefined,
    retries: task.agents[agent].retries,
    output,
  };
  writeTask(task);
}

export function setStatus(task: PipelineTask, status: PipelineStatus) {
  task.status = status;
  writeTask(task);
}

// ─── Env loader ───────────────────────────────────────────────────────────────
export function loadHermesEnv() {
  const envPath = paths.ENV_PATH;
  try {
    const raw = fs.readFileSync(envPath, 'utf-8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (!m) continue;
      if (!process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch { /* file missing — keys may come from shell env */ }
}

// ─── LLM wrapper ──────────────────────────────────────────────────────────────
export const LLM_MODEL = process.env.LLM_MODEL ?? 'claude-haiku-4-5-20251001';

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export function stripTerminalCodes(s: string): string {
  return s
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\[[0-9]*[A-Za-z]/g, '')
    .replace(/\r/g, '');
}

// CivicLens uses the local `claude` CLI (Claude Code) instead of the Anthropic
// API directly. This routes pipeline LLM calls through the user's Claude
// subscription rather than the API-key billing line. Set
// CIVICLENS_USE_CLAUDE_API=1 to fall back to the legacy fetch path.
async function claudeViaCli(
  messages: ChatMessage[],
  opts: { maxTokens?: number; timeoutMs?: number; model?: string } = {},
): Promise<string> {
  const system = messages.find(m => m.role === 'system')?.content;
  const userMsg = messages.filter(m => m.role !== 'system').map(m => m.content).join('\n\n');
  // No --bare: that flag forces ANTHROPIC_API_KEY only, which defeats the
  // purpose. Default mode uses the user's Claude subscription via OAuth.
  const args: string[] = ['--print', '--input-format', 'text', '--output-format', 'text'];
  if (opts.model) args.push('--model', opts.model);
  if (system) args.push('--append-system-prompt', system);

  const timeoutMs = opts.timeoutMs ?? 120_000;
  // Strip ANTHROPIC_API_KEY from child env so the CLI uses OAuth/subscription
  // auth instead of the dead pipeline API key. This is the whole point of the
  // CLI bridge — without this line we just shell-out to the same broken billing.
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv.ANTHROPIC_API_KEY;
  delete childEnv.ANTHROPIC_AUTH_TOKEN;
  return new Promise<string>((resolve, reject) => {
    const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'], env: childEnv });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`claude CLI timed out after ${timeoutMs}ms`)); }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`claude CLI spawn failed: ${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const detail = stderr.trim() || stdout.trim() || '<empty>';
        return reject(new Error(`claude CLI exit ${code}: ${detail.slice(0, 500)}`));
      }
      resolve(stripTerminalCodes(stdout.trim()));
    });
    child.stdin.write(userMsg);
    child.stdin.end();
  });
}

async function claudeViaApi(
  messages: ChatMessage[],
  opts: { maxTokens?: number; timeoutMs?: number; model?: string } = {},
): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not set in the CivicLens .env');
  const system = messages.find(m => m.role === 'system')?.content;
  const nonSystem = messages.filter(m => m.role !== 'system');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 120_000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: opts.model ?? LLM_MODEL,
        max_tokens: opts.maxTokens ?? 2048,
        ...(system ? { system } : {}),
        messages: nonSystem,
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await (res.json() as Promise<any>);
    return stripTerminalCodes((data.content?.[0]?.text ?? '').trim());
  } finally {
    clearTimeout(timer);
  }
}

async function claude(
  messages: ChatMessage[],
  opts: { maxTokens?: number; timeoutMs?: number; model?: string } = {},
): Promise<string> {
  return process.env.CIVICLENS_USE_CLAUDE_API === '1'
    ? claudeViaApi(messages, opts)
    : claudeViaCli(messages, opts);
}

async function grok(
  messages: ChatMessage[],
  opts: { maxTokens?: number; timeoutMs?: number; model?: string } = {},
): Promise<string> {
  const key = process.env.XAI_API_KEY;
  if (!key) throw new Error('XAI_API_KEY not set in the CivicLens .env');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 120_000);
  try {
    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model: opts.model ?? LLM_MODEL,
        max_tokens: opts.maxTokens ?? 2048,
        messages,
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`xAI API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await (res.json() as Promise<any>);
    return stripTerminalCodes((data.choices?.[0]?.message?.content ?? '').trim());
  } finally {
    clearTimeout(timer);
  }
}

export function llm(
  messages: ChatMessage[],
  opts: { maxTokens?: number; timeoutMs?: number; model?: string } = {},
): Promise<string> {
  const model = opts.model ?? LLM_MODEL;
  return model.startsWith('grok-') ? grok(messages, opts) : claude(messages, opts);
}

export function sanitizeJson(text: string): string {
  let inString = false;
  let escaped = false;
  let result = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { result += ch; escaped = false; continue; }
    if (ch === '\\' && inString) { result += ch; escaped = true; continue; }
    if (ch === '"') { result += ch; inString = !inString; continue; }
    if (inString) {
      if (ch === '\n') { result += '\\n'; continue; }
      if (ch === '\r') { result += '\\r'; continue; }
      if (ch === '\t') { result += '\\t'; continue; }
      if (ch.charCodeAt(0) < 0x20) continue;
    }
    result += ch;
  }
  return result;
}

export function extractJson(raw: string): unknown {
  let text = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  text = text.replace(/```(?:json|typescript|ts|js)?\n?([\s\S]*?)```/g, '$1').trim();
  text = sanitizeJson(text);
  try { return JSON.parse(text); } catch {}
  const start = text.search(/[\[{]/);
  if (start === -1) throw new Error('No JSON found in LLM output');
  const startChar = text[start];
  const endChar = startChar === '{' ? '}' : ']';
  let depth = 0, end = -1;
  for (let i = start; i < text.length; i++) {
    if (text[i] === startChar) depth++;
    else if (text[i] === endChar) { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) throw new Error('Unterminated JSON in LLM output');
  return JSON.parse(text.slice(start, end + 1));
}

export function extractCodeBlock(raw: string): string {
  const fenced = raw.match(/```(?:typescript|ts|js)?\n?([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) return trimmed;
  throw new Error('Could not extract code block from LLM output');
}

// ─── Neutrality checker ───────────────────────────────────────────────────────
// Word-boundary matching prevents false positives that killed the old substring
// check ("firefighter" ≠ "fighter", "heroin" ≠ "hero", "eradicate" ≠ "radical").
// Phrases with hyphens or spaces use a literal-string regex (no \b needed since
// the surrounding context is always alphabetic on both ends for these phrases).
export const FORBIDDEN: string[] = [
  // Charged single words — only where no neutral form exists
  'corrupt', 'crooked', 'dishonest', 'liar', 'traitor',
  'socialist', 'fascist', 'communist',
  'radical', 'extremist', 'fanatic',
  'hero', 'maverick', 'crusader',
  // Loaded verbs / phrases
  'rammed through', 'pushed through', 'snuck in',
  'claims to', 'pretends to',
  'far-left', 'far-right', 'ultra-left', 'ultra-right',
];

export function checkNeutrality(text: string): string[] {
  const lower = text.toLowerCase();
  return FORBIDDEN.filter(term => {
    // Multi-word / hyphenated: literal substring is safe — surrounding chars are
    // always non-word on at least one side (space or hyphen), so no false positives.
    if (/[\s-]/.test(term)) return lower.includes(term);
    // Single words: require word boundaries so "hero" doesn't flag "heroic",
    // "radical" doesn't flag "radicalize" used neutrally in a non-partisan sense.
    return new RegExp(`\\b${term}\\b`).test(lower);
  });
}

// ─── Valid US state codes ─────────────────────────────────────────────────────
export const US_STATES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC','US',
]);
