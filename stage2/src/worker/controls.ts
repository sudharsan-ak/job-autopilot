import type { Stage2Repository } from "../state/repositories.js";

export type WorkerControl = "PAUSE" | "STOP";

export function requestWorkerControl(repository: Stage2Repository, waveId: string, control: WorkerControl): void {
  const wave = repository.getWave(waveId);
  if (!wave) throw new Error(`Unknown wave: ${waveId}`);
  repository.setWaveState(waveId, String(wave.state), control);
  repository.addStateEvent(`${control}_REQUESTED`, {
    batchId: String(wave.batch_id),
    waveId,
  });
}
