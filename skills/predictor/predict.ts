import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from '../../db/init.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PIPELINE_DIR = path.resolve(__dirname, '..', '..', 'pipeline');

type VoteValue = 'yea' | 'nay' | 'abstain' | 'absent' | string;

interface Vote {
  billTitle: string;
  vote: VoteValue;
  date: string;
  source: string;
  sourceUrl: string;
  confidence: number;
}

interface MemberRecord {
  taskId: string;
  id: string;
  name: string;
  party: string;
  chamber: string;
  state: string;
  votes: Vote[];
}

interface CalibrationBucket {
  predictedLow: number;
  predictedHigh: number;
  actualRate: number;
  count: number;
}

interface ModelScore {
  model: string;
  sampleSize: number;
  trainSize: number;
  brierScore: number;
  logLoss: number;
  accuracy: number;
  meanPrediction: number;
  actualRate: number;
  buckets: CalibrationBucket[];
}

interface PredictorOutput {
  source: 'civiclens/predictor';
  generatedAt: string;
  subject: {
    id: string;
    name: string;
    chamber: string;
    party: string;
  };
  sampleSize: {
    memberVotes: number;
    binaryVotes: number;
    corpusMembers: number;
    peerMembers: number;
  };
  calibration: ModelScore[];
  bestModel: string | null;
  warnings: string[];
}

const MIN_BINARY_VOTES = 20;
const TRAIN_RATIO = 0.7;
const EPS = 1e-6;

interface ModelContext {
  train: Vote[];
  subject: MemberRecord;
  peers: MemberRecord[];
}

type Model = (ctx: ModelContext) => number;

const models: Record<string, Model> = {
  'naive-half': () => 0.5,
  'always-yes': () => 1.0,
  'historical-rate': ({ train }) => {
    const { yeas, total } = countBinary(train);
    return total > 0 ? yeas / total : 0.5;
  },
  'laplace-smoothed': ({ train }) => {
    const { yeas, total } = countBinary(train);
    return (yeas + 1) / (total + 2);
  },
  'party-class-rate': ({ train, peers }) => {
    const peerVotes = peers.flatMap((p) => p.votes);
    const { yeas: peerY, total: peerT } = countBinary(peerVotes);
    const { yeas: ownY, total: ownT } = countBinary(train);
    const peerRate = peerT > 0 ? peerY / peerT : 0.5;
    const ownRate = ownT > 0 ? ownY / ownT : peerRate;
    const ownWeight = Math.min(ownT / 50, 1);
    return ownWeight * ownRate + (1 - ownWeight) * peerRate;
  },
};

function countBinary(votes: Vote[]): { yeas: number; nays: number; total: number } {
  let yeas = 0;
  let nays = 0;
  for (const v of votes) {
    if (v.vote === 'yea') yeas += 1;
    else if (v.vote === 'nay') nays += 1;
  }
  return { yeas, nays, total: yeas + nays };
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

// DB-backed: reads votes for a single member from DuckDB. Replaces the
// per-task researcher.json scan. The shape matches the old MemberRecord so
// the model/scoring code is unchanged.
async function loadMemberFromDb(memberId: string): Promise<MemberRecord | null> {
  const conn = await getDb();
  const mr = await conn.run(
    `SELECT member_id, name, party, chamber, state FROM members WHERE member_id = ?`,
    [memberId],
  );
  const mRows = await mr.getRowObjects() as any[];
  if (mRows.length === 0) return null;
  const m = mRows[0];
  const vr = await conn.run(
    `SELECT question AS billTitle, position AS vote, date, source_url AS sourceUrl
     FROM votes WHERE member_id = ? ORDER BY date`,
    [memberId],
  );
  const vRows = await vr.getRowObjects() as any[];
  return {
    taskId: '', // not needed for DB-sourced records; pipeline run is the audit trail
    id: String(m.member_id),
    name: String(m.name ?? ''),
    party: String(m.party ?? ''),
    chamber: String(m.chamber ?? ''),
    state: String(m.state ?? ''),
    votes: vRows.map(v => ({
      billTitle: String(v.billTitle ?? ''),
      vote: String(v.vote ?? '') as VoteValue,
      date: v.date ? String(v.date) : '',
      source: 'govtrack.us',
      sourceUrl: String(v.sourceUrl ?? ''),
      confidence: 0.99,
    })),
  };
}

// DB-backed corpus loader (party + chamber peers only — that's all the
// predictor's party-class-rate model uses).
async function loadCorpusFromDb(excludeMemberId: string): Promise<MemberRecord[]> {
  const conn = await getDb();
  const r = await conn.run(
    `SELECT member_id FROM members WHERE member_id <> ?`,
    [excludeMemberId],
  );
  const rows = await r.getRowObjects() as any[];
  const out: MemberRecord[] = [];
  for (const row of rows) {
    const m = await loadMemberFromDb(String(row.member_id));
    if (m) out.push(m);
  }
  return out;
}

// Resolve a task ID to its member ID. researcher.json is still written per
// run (audit trail) and carries `data.id` as the canonical slug. We could
// also derive it from state.target.name, but the JSON read is one syscall.
function resolveMemberId(taskId: string): string | null {
  const rp = path.join(PIPELINE_DIR, taskId, 'researcher.json');
  if (!fs.existsSync(rp)) return null;
  try {
    const r = JSON.parse(fs.readFileSync(rp, 'utf8'));
    return r?.data?.id ?? null;
  } catch {
    return null;
  }
}

function bucketize(
  preds: Array<{ p: number; actual: number }>,
  nBuckets = 10,
): CalibrationBucket[] {
  const buckets: CalibrationBucket[] = [];
  for (let i = 0; i < nBuckets; i += 1) {
    const lo = i / nBuckets;
    const hi = (i + 1) / nBuckets;
    const inBucket = preds.filter(({ p }) => p >= lo && (i === nBuckets - 1 ? p <= hi : p < hi));
    if (inBucket.length === 0) continue;
    buckets.push({
      predictedLow: round(lo),
      predictedHigh: round(hi),
      actualRate: round(mean(inBucket.map((x) => x.actual))),
      count: inBucket.length,
    });
  }
  return buckets;
}

function round(n: number, digits = 3): number {
  const m = 10 ** digits;
  return Math.round(n * m) / m;
}

function scoreModel(
  name: string,
  model: Model,
  train: Vote[],
  test: Vote[],
  subject: MemberRecord,
  peers: MemberRecord[],
): ModelScore {
  const preds = test.map((v) => {
    const p = clamp(model({ train, subject, peers }), 0, 1);
    const actual = v.vote === 'yea' ? 1 : 0;
    return { p, actual };
  });
  const brier = mean(preds.map(({ p, actual }) => (p - actual) ** 2));
  const logLoss = -mean(
    preds.map(
      ({ p, actual }) =>
        actual * Math.log(Math.max(p, EPS)) + (1 - actual) * Math.log(Math.max(1 - p, EPS)),
    ),
  );
  const accuracy = mean(preds.map(({ p, actual }) => ((p >= 0.5 ? 1 : 0) === actual ? 1 : 0)));
  return {
    model: name,
    sampleSize: test.length,
    trainSize: train.length,
    brierScore: round(brier, 4),
    logLoss: round(logLoss, 4),
    accuracy: round(accuracy, 4),
    meanPrediction: round(mean(preds.map((x) => x.p)), 4),
    actualRate: round(mean(preds.map((x) => x.actual)), 4),
    buckets: bucketize(preds),
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export async function predictFromTask(taskId: string): Promise<PredictorOutput> {
  const memberId = resolveMemberId(taskId);
  if (!memberId) throw new Error(`No researcher.json / member id for task ${taskId}`);
  const subject = await loadMemberFromDb(memberId);
  if (!subject) throw new Error(`Member ${memberId} not found in DB — run db/sync-task first`);
  subject.taskId = taskId;
  const warnings: string[] = [];

  const binary = subject.votes
    .filter((v) => v.vote === 'yea' || v.vote === 'nay')
    .slice()
    .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));

  const corpus = await loadCorpusFromDb(memberId);
  const peers = corpus.filter(
    (m) => m.id !== subject.id && m.party === subject.party && m.chamber === subject.chamber,
  );

  const output: PredictorOutput = {
    source: 'civiclens/predictor',
    generatedAt: new Date().toISOString(),
    subject: {
      id: subject.id,
      name: subject.name,
      chamber: subject.chamber,
      party: subject.party,
    },
    sampleSize: {
      memberVotes: subject.votes.length,
      binaryVotes: binary.length,
      corpusMembers: corpus.length,
      peerMembers: peers.length,
    },
    calibration: [],
    bestModel: null,
    warnings,
  };

  if (binary.length < MIN_BINARY_VOTES) {
    warnings.push(
      `insufficient sample: ${binary.length} binary votes (minimum ${MIN_BINARY_VOTES}) — calibration skipped`,
    );
    return output;
  }

  const cut = Math.floor(binary.length * TRAIN_RATIO);
  const train = binary.slice(0, cut);
  const test = binary.slice(cut);
  if (test.length < 3) {
    warnings.push(`test set too small: ${test.length} votes after split`);
    return output;
  }

  const activeModels: Array<[string, Model]> = Object.entries(models).filter(([name]) => {
    if (name === 'party-class-rate' && peers.length === 0) {
      warnings.push(`party-class-rate skipped: no peers in corpus for ${subject.party} ${subject.chamber}`);
      return false;
    }
    return true;
  });

  output.calibration = activeModels.map(([name, model]) =>
    scoreModel(name, model, train, test, subject, peers),
  );

  const scored = output.calibration.filter((s) => !Number.isNaN(s.brierScore));
  if (scored.length > 0) {
    scored.sort((a, b) => a.brierScore - b.brierScore);
    output.bestModel = scored[0].model;
  }

  return output;
}

export async function writePrediction(taskId: string): Promise<string> {
  const out = await predictFromTask(taskId);
  const outPath = path.join(PIPELINE_DIR, taskId, 'predictor.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  return outPath;
}

function isMain(): boolean {
  return process.argv[1] === __filename;
}

if (isMain()) {
  const taskId = process.argv[2];
  if (!taskId) {
    console.error('Usage: tsx skills/predictor/predict.ts <task-id>');
    process.exit(1);
  }
  (async () => {
    try {
      const outPath = await writePrediction(taskId);
      const payload = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      console.log(JSON.stringify(payload, null, 2));
      console.error(`\nwrote ${outPath}`);
    } catch (err) {
      console.error(String(err));
      process.exit(1);
    }
  })();
}
