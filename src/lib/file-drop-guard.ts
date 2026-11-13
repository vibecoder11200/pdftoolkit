export function installFileDropGuard(target: Window): () => void {
  const guard = (event: DragEvent) => {
    if (Array.from(event.dataTransfer?.types ?? []).includes('Files')) event.preventDefault();
  };
  target.addEventListener('dragover', guard, true);
  target.addEventListener('drop', guard, true);
  return () => {
    target.removeEventListener('dragover', guard, true);
    target.removeEventListener('drop', guard, true);
  };
}
