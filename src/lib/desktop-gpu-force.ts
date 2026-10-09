import { isTauri } from './platform';

/*
 * Desktop force-dGPU flag bridge (plan 261009-0836 phase 2). The Rust side
 * owns the flag file (fixed path in app_config_dir, boolean-only JSON,
 * SEC-1) and the safe restart (detached spawn + skip-single-instance marker,
 * A4); this wrapper only invokes the commands — JS never touches the
 * filesystem for this. `null` = unsupported (web, or non-Windows desktop):
 * the toggle must not render for unsupported surfaces.
 */

export async function getGpuForce(): Promise<boolean | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<boolean>('get_gpu_force');
  } catch {
    return null;
  }
}

export async function setGpuForce(flag: boolean): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('set_gpu_force', { flag });
}

/**
 * Writes the flag then restarts the app through the Rust command (detached
 * spawn — the single-instance-safe path, red-team A4). Callers gate on the
 * job registry (F22 pattern) BEFORE calling: the restart kills running jobs.
 */
export async function restartWithGpuForce(flag: boolean): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('restart_with_gpu_force', { flag });
}
