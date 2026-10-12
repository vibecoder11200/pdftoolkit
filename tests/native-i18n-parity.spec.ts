import { describe, expect, it } from 'vitest';
import enCommon from '../src/locales/en/common.json';
import viCommon from '../src/locales/vi/common.json';

/*
 * i18n key parity for the native-engine surface (v0.6.0 phase 5, plan Risk
 * 4's mitigation): every key the new components render must exist in BOTH
 * locales — a missing key renders as the raw key string, which is exactly
 * the kind of drift that survives until someone opens the page in the
 * other language.
 */

const NATIVE_OCR_KEYS = [
  'engine_native',
  'engine_native_hint',
  'native_notice',
  'run_native_download',
  'native_backend',
  'native_backend_cpu_fallback',
  'fallback_in_app',
  'native_suggest_title',
  'native_suggest_body',
  'native_suggest_cta',
  'native_suggest_dismiss',
  'native_cpu_gate_title',
  'native_cpu_gate_body',
  'native_cpu_gate_continue',
  'native_cpu_gate_abort',
  'native_err_oom',
  'native_err_quarantined',
  'native_err_crashed',
  'native_err_download',
  'native_err_start_timeout',
  'native_err_os_blocked',
  'native_err_os_too_old',
  'native_err_load_failed',
  'native_err_backend_fault',
  'native_err_spawn',
  'native_err_io',
  'native_err_invalid',
  'native_err_busy',
  'native_err_cancelled',
] as const;

const NATIVE_SETTINGS_KEYS = [
  'native_title',
  'native_intro',
  'native_status',
  'native_status_unknown',
  'native_phase_notinstalled',
  'native_phase_checking',
  'native_phase_starting',
  'native_phase_ready',
  'native_phase_stopping',
  'native_phase_stopped',
  'native_phase_dead',
  'native_backend_label',
  'native_stop',
  'native_engine_dl',
  'native_model_dl',
  'native_download',
  'native_dl_progress',
  'native_resume_note',
  'native_cuda_title',
  'native_cuda_hint',
  'native_cuda_installed',
  'native_cuda_install',
  'native_cuda_remove',
  'native_cuda_needs_nvidia',
  'native_bench',
  'row_native_engine',
  'row_native_engine_hint',
] as const;

describe('native-engine i18n parity (both locales)', () => {
  for (const key of NATIVE_OCR_KEYS) {
    it(`ocr.${key} exists in en + vi`, () => {
      expect((enCommon as never as Record<string, Record<string, string>>).ocr[key], `en ocr.${key}`).toBeTruthy();
      expect((viCommon as never as Record<string, Record<string, string>>).ocr[key], `vi ocr.${key}`).toBeTruthy();
    });
  }
  for (const key of NATIVE_SETTINGS_KEYS) {
    it(`settings.${key} exists in en + vi`, () => {
      expect(
        (enCommon as never as Record<string, Record<string, string>>).settings[key],
        `en settings.${key}`,
      ).toBeTruthy();
      expect(
        (viCommon as never as Record<string, Record<string, string>>).settings[key],
        `vi settings.${key}`,
      ).toBeTruthy();
    });
  }
});
