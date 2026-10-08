import { describe, expect, it, vi } from 'vitest';
import {
  beginJob,
  endJob,
  getActiveJobsVersion,
  hasActiveJob,
  subscribeActiveJobs,
} from '../src/lib/jobs';

/*
 * Review P2-8: the job registry must be OBSERVABLE — a bare boolean read at
 * render time went stale, so the desktop-update F22 confirm could be skipped
 * when a job started after the consumer's last render.
 */

describe('job registry notifications', () => {
  it('begin/end notify subscribers and bump the version', () => {
    const listener = vi.fn();
    const unsub = subscribeActiveJobs(listener);
    const v0 = getActiveJobsVersion();
    beginJob('a');
    expect(hasActiveJob()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getActiveJobsVersion()).toBe(v0 + 1);
    endJob('a');
    expect(hasActiveJob()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
    unsub();
  });

  it('duplicate begin / unknown end do not notify', () => {
    const listener = vi.fn();
    const unsub = subscribeActiveJobs(listener);
    beginJob('x');
    beginJob('x'); // already active — no state change
    endJob('nope'); // never active — no state change
    expect(listener).toHaveBeenCalledTimes(1);
    endJob('x');
    expect(listener).toHaveBeenCalledTimes(2);
    unsub();
  });

  it('unsubscribed listeners stop hearing about changes', () => {
    const listener = vi.fn();
    const unsub = subscribeActiveJobs(listener);
    unsub();
    beginJob('later');
    endJob('later');
    expect(listener).not.toHaveBeenCalled();
  });
});
