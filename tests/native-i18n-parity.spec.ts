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

// v0.8.0: the two new tools + the chaining chip + the shared 9-grid labels.
// Every key these components render must exist in BOTH locales.
const WATERMARK_KEYS = [
  'title',
  'dropzone_title',
  'dropzone_hint',
  'tab_text',
  'tab_image',
  'content_label',
  'content_placeholder',
  'font_size',
  'opacity',
  'rotation',
  'rotation_free',
  'tiled',
  'tile_columns',
  'image_pick',
  'image_change',
  'image_none_hint',
  'image_opacity',
  'image_scale',
  'position',
  'cta',
  'cta_batch',
  'progress_working',
  'progress_batch',
  'progress_done',
  'progress_idle',
  'selected_count',
  'thumb_hint',
  'batch_summary',
  'err_no_file',
  'err_no_selection',
  'err_failed',
  'err_encrypted',
  'decrypt_cta',
  'err_image_unsupported',
  'err_image_too_big',
  'err_no_image',
] as const;

const PAGE_NUMBERS_KEYS = [
  'title',
  'dropzone_title',
  'dropzone_hint',
  'preset_q',
  'preset1',
  'preset2',
  'preset3',
  'preset4',
  'preset_advanced',
  'preset3_template',
  'template_label',
  'preview_heading',
  'preview_excluded',
  'preview_no_file',
  'position',
  'margin',
  'font_size',
  'start_number',
  'cta',
  'progress_working',
  'progress_done',
  'progress_idle',
  'selected_count',
  'thumb_hint',
  'err_no_file',
  'err_no_selection',
  'err_failed',
  'err_encrypted',
  'decrypt_cta',
] as const;

const GRID_POS_KEYS = [
  'top_left',
  'top_center',
  'top_right',
  'middle_left',
  'center',
  'middle_right',
  'bottom_left',
  'bottom_center',
  'bottom_right',
] as const;

const CHIP_KEYS = [
  'chip_label',
  'chip_title',
  'chip_cancel',
] as const;

const HOME_REASON_KEYS = ['reason_watermark', 'reason_page_numbers'] as const;

function commonOf(
  json: unknown,
): Record<string, Record<string, string>> {
  return json as Record<string, Record<string, string>>;
}

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

describe('v0.8.0 i18n parity (both locales)', () => {
  const en = commonOf(enCommon);
  const vi = commonOf(viCommon);
  for (const key of WATERMARK_KEYS) {
    it(`watermark.${key} exists in en + vi`, () => {
      expect(en.watermark?.[key], `en watermark.${key}`).toBeTruthy();
      expect(vi.watermark?.[key], `vi watermark.${key}`).toBeTruthy();
    });
  }
  for (const key of PAGE_NUMBERS_KEYS) {
    it(`page-numbers.${key} exists in en + vi`, () => {
      expect(en['page-numbers']?.[key], `en page-numbers.${key}`).toBeTruthy();
      expect(vi['page-numbers']?.[key], `vi page-numbers.${key}`).toBeTruthy();
    });
  }
  for (const key of GRID_POS_KEYS) {
    it(`grid_pos.${key} exists in en + vi`, () => {
      expect(en.grid_pos?.[key], `en grid_pos.${key}`).toBeTruthy();
      expect(vi.grid_pos?.[key], `vi grid_pos.${key}`).toBeTruthy();
    });
  }
  for (const key of CHIP_KEYS) {
    it(`chip.${key} exists in en + vi`, () => {
      expect(en.chip?.[key], `en chip.${key}`).toBeTruthy();
      expect(vi.chip?.[key], `vi chip.${key}`).toBeTruthy();
    });
  }
  for (const key of HOME_REASON_KEYS) {
    it(`home.${key} exists in en + vi`, () => {
      expect(en.home?.[key], `en home.${key}`).toBeTruthy();
      expect(vi.home?.[key], `vi home.${key}`).toBeTruthy();
    });
  }
  it('preset3 templates carry the tokens in both locales', () => {
    for (const json of [en, vi]) {
      expect(json['page-numbers'].preset3_template).toContain('{n}');
      expect(json['page-numbers'].preset3_template).toContain('{total}');
    }
  });
});
