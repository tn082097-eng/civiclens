import { predictFromTask } from '../skills/predictor/predict.js';
import type { PipelineTask } from '../lib/types.js';
import { ok, fail, warn, writePipe, markAgent } from './shared.js';

export async function runPredictor(task: PipelineTask): Promise<boolean> {
  markAgent(task, 'predictor', 'running');

  try {
    const output = await predictFromTask(task.taskId);
    writePipe(task.taskId, 'predictor', output);
    markAgent(task, 'predictor', 'complete', {
      bestModel: output.bestModel,
      modelsScored: output.calibration.length,
      binaryVotes: output.sampleSize.binaryVotes,
      warnings: output.warnings.length,
    });
    if (output.calibration.length === 0) {
      warn('Predictor', output.warnings[0] ?? 'no calibration produced');
    } else {
      const best = output.calibration.find(c => c.model === output.bestModel);
      const detail = best
        ? `${output.calibration.length} models, best=${output.bestModel} (Brier ${best.brierScore})`
        : `${output.calibration.length} models scored`;
      ok('Predictor', detail);
    }
    return true;
  } catch (e: any) {
    fail('Predictor', e?.message ?? String(e));
    markAgent(task, 'predictor', 'failed', { error: e?.message ?? String(e) });
    return false;
  }
}
