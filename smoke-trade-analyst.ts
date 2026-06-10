import { runTradeAnalyst } from './agents/trade-analyst.js';
import { loadHermesEnv } from './agents/shared.js';
import type { PipelineTask } from './lib/types.js';

async function main() {
  loadHermesEnv();
  const task: PipelineTask = {
    taskId: 'smoke-test',
    target: { name: 'Marjorie Taylor Greene', type: 'politician' },
    status: 'running',
    agents: {
      'trade-analyst': { status: 'pending', startedAt: new Date().toISOString() }
    } as any,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await runTradeAnalyst(task);
  
  const { readPipe } = await import('./agents/shared.js');
  const output = readPipe(task.taskId, 'trade-analyst');
  if (output) {
    console.log('\n=== TRADE ANALYST OUTPUT ===');
    console.log('suspicionLevel:', output.suspicionLevel);
    console.log('totalSuspiciousTrades:', output.totalSuspiciousTrades);
    console.log('totalDiscretionaryTrades:', output.totalDiscretionaryTrades);
    console.log('portfolio positions:', output.allDiscretionaryTrades?.length);
    console.log('\ntopFindings:');
    output.topFindings?.forEach((f: any, i: number) => {
      console.log(`  ${i+1}. ${f.tx_date} ${f.ticker} (${f.tx_type}) | ${f.days_before_vote}d before`);
      console.log(`     vote: ${String(f.vote_question ?? '').slice(0, 80)}`);
    });
    console.log('\ntradeNarrative:');
    console.log(output.tradeNarrative);
  }
}
main().catch(console.error);
