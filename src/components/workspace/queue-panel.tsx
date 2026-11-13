import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useQueueItems, queueStore } from "../../lib/queue-store";
import { Button } from "../ui/button";

/*
 * Phase-7 minimal batch queue UI (plan 261112-0955): enqueue merge/compress
 * over selected files, per-item state + progress + actions, mounted under
 * every tool shell. Hidden with zero items. Delivery goes through the
 * phase-3 contract (typed report + ledger): a partial save shows the item
 * failed and RESUME re-delivers ONLY undelivered queue ids.
 */

const POLL_MS = 300;

type QueueOperationId = 'merge' | 'compress' | 'diagnose' | 'repair';

const TERMINAL: string[] = ["succeeded", "cancelled"];

/** Per-item action visibility (resume excludes 'queued': nothing to resume). */
const RESUME_STATES: string[] = ["paused", "failed", "awaiting-input"];
const CANCEL_STATES: string[] = ["queued", "running", "paused", "awaiting-input"];

const STATE_KEYS: Record<string, string> = {
  queued: "queue.state_queued",
  running: "queue.state_running",
  "awaiting-input": "queue.state_awaiting",
  paused: "queue.state_paused",
  succeeded: "queue.state_succeeded",
  failed: "queue.state_failed",
  cancelled: "queue.state_cancelled",
};

export function QueuePanel() {
  const { t } = useTranslation(["common"]);
  const { items, revision } = useQueueItems();
  const [operationId, setOperationId] = useState<QueueOperationId>("merge");
  const fileRef = useRef<HTMLInputElement>(null);
  const [tick, setTick] = useState(0);
  const [open, setOpen] = useState(false);
  // The runner is React-free; poll while anything is non-terminal.
  // 'failed' is resumable but runner-quiet - the poll would spin forever on
  // a lingering failure; resume()/cancel() bump the store instead.
  const active = items.some((i) => !TERMINAL.includes(i.state) && i.state !== 'failed');
  useEffect(() => {
    if (active) {
      const id = setInterval(() => setTick((v) => v + 1), POLL_MS);
      return () => clearInterval(id);
    }
  }, [active]);
  void revision;
  void tick;

  // Collapsed + empty: a single ghost toggle (no file input in the DOM, so
  // existing strict-mode selectors on tool pages keep their counts).
  if (!open && items.length === 0) {
    return (
      <div className="mt-3.5 flex">
        <Button variant="ghost" data-testid="queue-toggle" onClick={() => setOpen(true)}>
          {t("queue.title")}
        </Button>
      </div>
    );
  }

  const add = () => {
    const picked = fileRef.current?.files;
    if (!picked || picked.length === 0) return;
    queueStore.enqueue(operationId, Array.from(picked));
    if (fileRef.current) fileRef.current.value = "";
  };
  const stateLabel = (s: string) => t(STATE_KEYS[s] ?? "queue.state_queued");

  return (
    <section
      data-testid="queue-panel"
      aria-label={t("queue.title")}
      className="mt-3.5 rounded-2xl border border-border-default bg-surface-card px-5 py-4"
    >
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-[15px] font-bold">{t("queue.title")}</h3>
        <span className="flex-1" />
        <select
          aria-label={t("queue.operation")}
          value={operationId}
          data-testid="queue-op-select"
          onChange={(e) => setOperationId(e.target.value as QueueOperationId)}
          className="min-h-11 rounded-lg border border-border-strong bg-surface-card px-3 text-[13px]"
        >
          <option value="merge">{t("queue.op_merge")}</option>
          <option value="compress">{t("queue.op_compress")}</option>
          <option value="diagnose">{t("queue.op_diagnose")}</option>
          <option value="repair">{t("queue.op_repair")}</option>
        </select>
        <input
          ref={fileRef}
          type="file" multiple accept="application/pdf"
          data-testid="queue-input"
          aria-label={t("queue.pick")}
          className="text-[13px] text-text-muted"
        />
        <Button data-testid="queue-add" onClick={add}>{t("queue.add")}</Button>
      </div>
      <ul className="mt-3 flex flex-col gap-2.5">
        {items.map((item) => {
          const first = item.inputs[0];
          const extra = item.inputs.length > 1 ? ` +${item.inputs.length - 1}` : "";
          const label = first ? first.name + extra : item.id;
          const out = item.artifacts[0];
          return (
            <li key={item.id} data-testid="queue-item" className="flex flex-wrap items-center gap-3 rounded-xl border border-border-default px-3.5 py-2.5">
              <span className="max-w-52 truncate text-[13px] font-semibold">
                {label}
                {out ? " → " + out.filename : ""}
              </span>
              <span data-testid="queue-item-state" className="rounded-full border px-2.5 py-0.5 text-[12px] font-semibold">
                {stateLabel(item.state)}{item.error ? ": " + item.error : ""}
              </span>
              <span className="text-[12px] text-text-muted tabular-nums">{Math.round(item.progress * 100)}%</span>
              <span className="flex-1" />
              {item.state === "running" ? (
                <Button variant="ghost" data-testid="queue-pause" onClick={() => queueStore.pause(item.id)}>{t("queue.pause")}</Button>
              ) : null}
              {RESUME_STATES.includes(item.state) ? (
                <Button variant="ghost" data-testid="queue-resume" onClick={() => queueStore.resume(item.id)}>{t("queue.resume")}</Button>
              ) : null}
              {CANCEL_STATES.includes(item.state) ? (
                <Button variant="ghost" data-testid="queue-cancel" onClick={() => queueStore.cancel(item.id)}>{t("queue.cancel")}</Button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {items.length > 0 && items.every((i) => TERMINAL.includes(i.state)) ? (
        <div className="mt-3 flex justify-end">
          <Button variant="ghost" data-testid="queue-clear" onClick={() => queueStore.clearFinished()}>{t("queue.clear")}</Button>
        </div>
      ) : null}
    </section>
  );
}
