/**
 * WaitEngine — Unified wait/wake system.
 *
 * Indexes threads by what they wait on for push-based wakeup.
 * No polling needed: signals go directly to relevant waiters.
 */

import { Logger, LogCategory } from '../logger';
import { Thread, ThreadState, WaitReason, WaitInfo, WAIT_OBJECT_0, WAIT_TIMEOUT } from './types';
import { SyncObjectManager } from './sync-objects';
import { hypercallDataManager } from '../cpu/hypercall-data';

export class WaitEngine {
    // Push-based indexes — O(1) signal delivery
    private handleWaiters = new Map<number, Set<number>>();     // Event/Mutex/Semaphore/CS-LockSem handle → threadIds
    private messageWaiters = new Set<number>();                 // GetMessage/WaitMessage → threadIds
    private sleepWaiters = new Set<number>();                   // Sleep → threadIds (timeout-only)

    private syncHandleWaiters(handle: number): void {
        const hasWaiters = (this.handleWaiters.get(handle)?.size ?? 0) > 0;
        hypercallDataManager.setEventMirrorHasWaiters(handle, hasWaiters);
        hypercallDataManager.setMutexMirrorHasWaiters(handle, hasWaiters);
    }

    /**
     * Register a thread as waiting. Must be called when thread enters WAITING state.
     */
    registerWait(thread: Thread): void {
        const info = thread.waitInfo;
        if (!info) return;
        if (info.msgWakeResult !== undefined) this.messageWaiters.add(thread.id);

        switch (info.reason) {
            case WaitReason.SLEEP:
                this.sleepWaiters.add(thread.id);
                break;

            case WaitReason.SINGLE_OBJECT:
            case WaitReason.MULTIPLE_OBJECTS:
            case WaitReason.SRW_LOCK:
                for (const h of info.handles) {
                    let set = this.handleWaiters.get(h);
                    if (!set) { set = new Set(); this.handleWaiters.set(h, set); }
                    set.add(thread.id);
                    this.syncHandleWaiters(h);
                }
                break;

            case WaitReason.CRITICAL_SECTION:
                // CS contention now uses LockSemaphore event handle — same as SINGLE_OBJECT
                for (const h of info.handles) {
                    let set = this.handleWaiters.get(h);
                    if (!set) { set = new Set(); this.handleWaiters.set(h, set); }
                    set.add(thread.id);
                    this.syncHandleWaiters(h);
                }
                break;

            case WaitReason.MESSAGE:
                this.messageWaiters.add(thread.id);
                break;
        }
    }

    /**
     * Unregister a thread from waiting. Must be called when thread leaves WAITING state.
     */
    unregisterWait(thread: Thread): void {
        const info = thread.waitInfo;
        if (!info) return;
        if (info.msgWakeResult !== undefined) this.messageWaiters.delete(thread.id);

        switch (info.reason) {
            case WaitReason.SLEEP:
                this.sleepWaiters.delete(thread.id);
                break;

            case WaitReason.SINGLE_OBJECT:
            case WaitReason.MULTIPLE_OBJECTS:
            case WaitReason.SRW_LOCK:
                for (const h of info.handles) {
                    const set = this.handleWaiters.get(h);
                    if (set) {
                        set.delete(thread.id);
                        if (set.size === 0) this.handleWaiters.delete(h);
                    }
                    this.syncHandleWaiters(h);
                }
                break;

            case WaitReason.CRITICAL_SECTION:
                // CS contention now uses LockSemaphore event handle — same as SINGLE_OBJECT
                for (const h of info.handles) {
                    const set = this.handleWaiters.get(h);
                    if (set) {
                        set.delete(thread.id);
                        if (set.size === 0) this.handleWaiters.delete(h);
                    }
                    this.syncHandleWaiters(h);
                }
                break;

            case WaitReason.MESSAGE:
                this.messageWaiters.delete(thread.id);
                break;
        }
    }

    /**
     * Get thread IDs waiting on a specific handle.
     * Returns a copy to avoid mutation during iteration.
     */
    getHandleWaiters(handle: number): number[] {
        const set = this.handleWaiters.get(handle);
        return set ? Array.from(set) : [];
    }

    /**
     * Get the first message waiter matching a specific thread ID (or any).
     */
    getMessageWaiter(targetThreadId?: number): number | null {
        if (targetThreadId !== undefined) {
            return this.messageWaiters.has(targetThreadId) ? targetThreadId : null;
        }
        for (const id of this.messageWaiters) return id;
        return null;
    }

    reset(): void {
        this.handleWaiters.clear();
        this.messageWaiters.clear();
        this.sleepWaiters.clear();
    }
}
