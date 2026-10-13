import type { OmniExternalPlaybackEngine, OmniExternalPlaybackState } from '../../types/onlineMusic';
import type { AutomixDeckId } from '../automix/automixSession';
import { envelopeEndsAt, envelopeValueAt, type DeckGainEnvelope } from '../gainEnvelope';

// src/services/externalPlayback/externalVolumeMirror.ts
// Plays Folia's gain moves on Music.app's volume: the user volume × the bound deck's Automix envelope × the pause
// fade, read slightly ahead of the audio clock and sent as 0–100 steps with at most one command in flight. When
// Folia stops driving Music it gives the user volume back once Music is no longer playing our track.

/** Evaluated this far ahead of the AudioContext clock to absorb the IPC round trip. */
export const MIRROR_LOOKAHEAD_SEC = 0.06;
/** Resend period while an envelope is moving (20 Hz). */
export const MIRROR_TICK_MS = 50;
/** Longest wait for Music to confirm it stopped playing our track before the user volume is restored anyway. */
export const MIRROR_RESTORE_TIMEOUT_MS = 500;
/** Trailing throttle for user-volume changes: a dragged slider sends at most one command per window. */
export const EXTERNAL_VOLUME_THROTTLE_MS = 100;

export interface ExternalVolumeTarget {
    engine: OmniExternalPlaybackEngine;
    mediaId: string | null;
    /** Whose envelope applies; null = unknown deck, factor 1. */
    deck: AutomixDeckId | null;
    carrier: { readonly paused: boolean };
}

export interface ExternalVolumeMirrorOptions {
    audioNow: () => number | null;          // AudioContext.currentTime, null while there is no graph
    now?: () => number;                     // wall ms, compared with sampledAtMs
    setTimer?: (callback: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
}

/** One gain source: the value it was cancelled-and-held at, and the envelope that took over from there. */
interface Track {
    held: number;
    envelope: DeckGainEnvelope | null;
}

/** Waiting to give one engine the user volume back. */
interface Restore {
    mediaId: string | null;
    yieldedAt: number;
    unsubscribe: () => void;
    timer: unknown;
}

/** What one engine was told; at most one command in flight, only the newest value queued behind it. */
interface Channel {
    engine: OmniExternalPlaybackEngine;
    /** Last percentage sent (assumed applied while in flight); null before the first send or after a refusal. */
    sentPct: number | null;
    /** Anything was ever sent: a null sentPct then means Music's volume is unknown, not untouched. */
    everSent: boolean;
    /** The next value goes out even if it repeats sentPct (a new drive: the listener may have moved Music's slider). */
    resend: boolean;
    inFlight: boolean;
    pendingPct: number | null;
    restore: Restore | null;
}

const toPct = (volume: number): number => Math.round(Math.min(1, Math.max(0, volume)) * 100);

// Runs an engine command so a synchronous throw arrives as a rejection like every other failure.
const invoke = (command: () => Promise<void>): Promise<void> => {
    try {
        return Promise.resolve(command());
    } catch (error) {
        return Promise.reject(error);
    }
};

export class ExternalVolumeMirror {
    private readonly audioNow: () => number | null;
    private readonly now: () => number;
    private readonly setTimer: (callback: () => void, ms: number) => unknown;
    private readonly clearTimer: (handle: unknown) => void;

    private readonly tracks: Record<AutomixDeckId | 'fade', Track> = {
        A: { held: 1, envelope: null },
        B: { held: 1, envelope: null },
        fade: { held: 1, envelope: null },
    };
    private readonly channels = new WeakMap<OmniExternalPlaybackEngine, Channel>();

    private userVolume: number | null = null;
    private target: ExternalVolumeTarget | null = null;
    private driving = false;
    /** The bound carrier was seen playing since bind; from then on a paused carrier never raises Music. */
    private seenPlaying = false;
    private tickTimer: unknown = null;
    private throttleTimer: unknown = null;
    private warned = false;

    constructor(options: ExternalVolumeMirrorOptions) {
        this.audioNow = options.audioNow;
        this.now = options.now ?? (() => Date.now());
        this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
        this.clearTimer = options.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
    }

    // Records the slider; the latest value goes out at the end of each throttle window.
    setUserVolume(volume: number): void {
        this.guard(() => {
            if (!Number.isFinite(volume)) return;
            this.userVolume = Math.min(1, Math.max(0, volume));
            if (this.throttleTimer !== null) return;
            this.throttleTimer = this.setTimer(() => this.guard(() => {
                this.throttleTimer = null;
                this.flushUserVolume();
            }), EXTERNAL_VOLUME_THROTTLE_MS);
        });
    }

    handleDeckEnvelope(deck: AutomixDeckId, envelope: DeckGainEnvelope): void {
        this.guard(() => {
            this.intake(this.tracks[deck], envelope);
            if (this.target?.deck === deck) this.update();
        });
    }

    handleFadeEnvelope(envelope: DeckGainEnvelope): void {
        this.guard(() => {
            this.intake(this.tracks.fade, envelope);
            this.update();
        });
    }

    // Follows this engine, idle until drive(); a pending restore on the same engine is dropped, the new song takes over.
    bind(target: ExternalVolumeTarget): void {
        this.guard(() => {
            if (this.target && this.target.engine !== target.engine) this.unbind();
            this.stopTick();
            this.target = target;
            this.driving = false;
            this.seenPlaying = false;
            this.cancelRestore(this.channelFor(target.engine));
        });
    }

    // Folia is playing the bound song: send the product now and on every change.
    drive(): void {
        this.guard(() => {
            const target = this.target;
            if (!target) return;
            this.driving = true;
            const channel = this.channelFor(target.engine);
            this.cancelRestore(channel);
            channel.resend = true;
            this.update();
        });
    }

    // Stops driving; the user volume goes back once Music is not playing ours, or after MIRROR_RESTORE_TIMEOUT_MS.
    yieldControl(): void {
        this.guard(() => {
            const target = this.target;
            if (!target) return;
            this.driving = false;
            this.stopTick();
            this.beginRestore(this.channelFor(target.engine), target.mediaId);
        });
    }

    // yieldControl() and forget the target; a pending restore still completes.
    unbind(): void {
        this.guard(() => {
            this.yieldControl();
            this.target = null;
            this.seenPlaying = false;
        });
    }

    // unbind() and stop ticking; the instance stays usable (StrictMode re-runs effects).
    dispose(): void {
        this.guard(() => {
            this.unbind();
            this.stopTick();
            if (this.throttleTimer !== null) this.clearTimer(this.throttleTimer);
            this.throttleTimer = null;
        });
    }

    // Cancel-and-hold: the track keeps the value it had now, and the new envelope takes over from there.
    private intake(track: Track, envelope: DeckGainEnvelope): void {
        track.held = envelopeValueAt(track.envelope, track.held, this.audioNow() ?? Infinity);
        track.envelope = envelope;
    }

    // A user-volume change at the end of its throttle window: the product while driving, the plain volume while idle.
    private flushUserVolume(): void {
        const target = this.target;
        if (!target || this.userVolume === null) return;
        if (this.driving) {
            this.update();
            return;
        }
        const channel = this.channelFor(target.engine);
        // A pending restore sends the then-current user volume once Music has stopped playing ours.
        if (!channel.restore) this.send(channel, toPct(this.userVolume));
    }

    // Evaluates user × deck × fade ahead of the audio clock, sends it, and keeps ticking while an envelope moves.
    private update(): void {
        const target = this.target;
        if (!target || !this.driving) return;
        if (!target.carrier.paused) this.seenPlaying = true;
        if (this.userVolume === null) return;
        const audio = this.audioNow();
        const time = audio === null ? Infinity : audio + MIRROR_LOOKAHEAD_SEC;
        const deck = target.deck ? this.tracks[target.deck] : null;
        const fade = this.tracks.fade;

        const value = this.userVolume
            * (deck ? envelopeValueAt(deck.envelope, deck.held, time) : 1)
            * envelopeValueAt(fade.envelope, fade.held, time);
        const channel = this.channelFor(target.engine);
        const latest = channel.pendingPct ?? channel.sentPct;
        let pct = toPct(value);
        // A tail settle pauses the carrier and then ramps its fade back to 1; that must not make Music audible again.
        // After a refusal Music may be anywhere, so it is held at 0 rather than raised.
        if (target.carrier.paused && this.seenPlaying && channel.everSent) pct = Math.min(pct, latest ?? 0);
        this.send(channel, pct);

        const moving = time < envelopeEndsAt(deck?.envelope ?? null) || time < envelopeEndsAt(fade.envelope);
        if (moving && this.tickTimer === null) {
            this.tickTimer = this.setTimer(() => this.guard(() => {
                this.tickTimer = null;
                this.update();
            }), MIRROR_TICK_MS);
        }
    }

    private stopTick(): void {
        if (this.tickTimer !== null) this.clearTimer(this.tickTimer);
        this.tickTimer = null;
    }

    private channelFor(engine: OmniExternalPlaybackEngine): Channel {
        let channel = this.channels.get(engine);
        if (!channel) {
            channel = { engine, sentPct: null, everSent: false, resend: false, inFlight: false, pendingPct: null, restore: null };
            this.channels.set(engine, channel);
        }
        return channel;
    }

    // Skips a repeat of the last value; behind a command in flight only the newest value waits.
    private send(channel: Channel, pct: number): void {
        if (channel.inFlight) {
            channel.pendingPct = pct;
            return;
        }
        if (pct === channel.sentPct && !channel.resend) return;
        channel.inFlight = true;
        channel.sentPct = pct;
        channel.everSent = true;
        channel.resend = false;
        // Refused while Music is not running, or on a control timeout that may still have applied it: either way
        // Music's volume is unknown then, and the next value goes out regardless.
        invoke(() => channel.engine.setVolume(pct / 100)).then(
            () => this.settle(channel),
            () => {
                channel.sentPct = null;
                this.settle(channel);
            },
        );
    }

    private settle(channel: Channel): void {
        this.guard(() => {
            channel.inFlight = false;
            const pending = channel.pendingPct;
            channel.pendingPct = null;
            if (pending !== null) this.send(channel, pending);
        });
    }

    // Waits for a reading taken after the yield that shows Music paused, stopped or on another track, or the timeout.
    // Skipped only for an engine never sent anything, or one settled at the user volume; an unknown volume (after a
    // refusal) or a command still in flight may leave Music below it.
    private beginRestore(channel: Channel, mediaId: string | null): void {
        if (channel.restore || this.userVolume === null || !channel.everSent) return;
        if (!channel.inFlight && channel.sentPct === toPct(this.userVolume)) return;
        const yieldedAt = this.now();
        const restore: Restore = { mediaId, yieldedAt, unsubscribe: () => undefined, timer: null };
        channel.restore = restore;
        restore.timer = this.setTimer(() => this.guard(() => this.finishRestore(channel, restore)), MIRROR_RESTORE_TIMEOUT_MS);
        const unsubscribe = channel.engine.subscribeState((state: OmniExternalPlaybackState) => this.guard(() => {
            if (state.sampledAtMs < yieldedAt) return;
            if (state.state !== 'playing' || state.mediaId !== mediaId) this.finishRestore(channel, restore);
        }));
        // An engine that answers the subscription synchronously may already have finished this restore.
        if (channel.restore === restore) restore.unsubscribe = unsubscribe;
        else unsubscribe();
    }

    private finishRestore(channel: Channel, restore: Restore): void {
        if (channel.restore !== restore) return;
        this.cancelRestore(channel);
        if (this.userVolume !== null) this.send(channel, toPct(this.userVolume));
    }

    private cancelRestore(channel: Channel): void {
        const restore = channel.restore;
        if (!restore) return;
        channel.restore = null;
        restore.unsubscribe();
        this.clearTimer(restore.timer);
    }

    // Public entry points and timer callbacks never throw: the first failure is logged, later ones are dropped.
    private guard(action: () => void): void {
        try {
            action();
        } catch (error) {
            if (this.warned) return;
            this.warned = true;
            console.warn('[ExternalVolumeMirror] failed to update Music volume', error);
        }
    }
}
