import { useTranslation } from 'react-i18next';
import { canSaveElsewhere } from '../../lib/download';
import { Button } from './button';

/*
 * "Chọn nơi lưu" companion to a tool's primary run button (v0.3.0 phase 4).
 * Renders only where the File System Access picker exists (Chromium — the
 * e2e suite asserts count 0 elsewhere). The caller owns the disabled gate
 * (the same one as the primary button) and the delivery via
 * deliverBytes(..., 'pick').
 */
export function SaveElsewhereButton({
  disabled,
  onClick,
}: {
  disabled?: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  if (!canSaveElsewhere()) return null;
  return (
    <Button variant="secondary" disabled={disabled} onClick={onClick}>
      {t('save_elsewhere')}
    </Button>
  );
}
