import type { SongResult } from '../../types';
import {
    OnlineProviderError,
    type OmniExternalPlaybackEngine,
    type OmniExternalPlaybackState,
} from '../../types/onlineMusic';

// src/services/externalPlayback/externalPlaybackSync.ts
// Keeps one song's silent carrier <audio> and Music.app in lock-step: the listener's play / pause / seek on the
// carrier are mirrored to Music, and the carrier's clock is steered from Music's reported position.

export const SYNC_DRIFT_IGNORE_SEC = 0.08;
export const SYNC_DRIFT_SEEK_SEC = 1;
export const SYNC_RATE_NUDGE = 0.05;
export const SYNC_START_TIMEOUT_MS = 8000;
export const SYNC_END_GRACE_SEC = 1.5;
export const SYNC_SETTLE_MS = 1000;
export const SYNC_START_ADVANCE_SEC = 0.05;
/** Chromium's minimum playbackRate: the carrier crawls at it while Music buffers after a play outside the start hold. */
export const SYNC_HOLD_RATE = 0.0625;

const PROVIDER_ID = 'apple-music';

export interface ExternalPlaybackCarrier {
    currentTime: number;
    playbackRate: number;
    readonly paused: boolean;
    readonly duration: number;
    pause(): void;
    play(): Promise<void>;
    addEventListener(type: 'play' | 'pause' | 'seeked', listener: () => void): void;
    removeEventListener(type: 'play' | 'pause' | 'seeked', listener: () => void): void;
}

export type ExternalPlaybackIssue =
    | { kind: 'takeover'; reason: 'track-changed' | 'engine-stopped' }
    | { kind: 'failure'; error: unknown };

export interface ExternalPlaybackSyncOptions {
    engine: OmniExternalPlaybackEngine;
    song: SongResult;
    carrier: ExternalPlaybackCarrier;
    now?: () => number;
    setTimer?: (callback: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
    onHoldReleased: () => void;
    onIssue: (issue: ExternalPlaybackIssue) => void;
}

/** What the controller believes Music is doing: the latest fresh report, overwritten by what its own commands imply. */
type KnownEngineState = Pick<OmniExternalPlaybackState, 'state' | 'mediaId'>;

/**
 * Waiting for Music to become audible after a play. 'start' is the start hold (the session keeps the carrier
 * paused); 'rate' is the rate hold (the carrier keeps playing at SYNC_HOLD_RATE).
 */
interface AudibleWait {
    mode: 'start' | 'rate';
    targetPos: number;
    firstPlayingPos: number | null;
    reseekSent: boolean;
    timer: unknown;
}

// The bridge rejects anything but a finite position >= 0, float noise like -1e-9 included.
const toEnginePosition = (positionSec: number): number => (
    Number.isFinite(positionSec) ? Math.max(0, positionSec) : 0
);

// Runs an engine command so a synchronous throw arrives as a rejection like every other failure.
const invoke = (command: () => Promise<void>): Promise<void> => {
    try {
        return Promise.resolve(command());
    } catch (error) {
        return Promise.reject(error);
    }
};

export class ExternalPlaybackSync {
    private readonly engine: OmniExternalPlaybackEngine;
    private readonly song: SongResult;
    private readonly carrier: ExternalPlaybackCarrier;
    private readonly mediaId: string | null;
    private readonly now: () => number;
    private readonly setTimer: (callback: () => void, ms: number) => unknown;
    private readonly clearTimer: (handle: unknown) => void;
    private readonly onHoldReleased: () => void;
    private readonly onIssue: (issue: ExternalPlaybackIssue) => void;

    private started = false;
    private disposed = false;
    private unsubscribe: (() => void) | null = null;

    private known: KnownEngineState | null = null;
    private lastCommandAtMs = Number.NEGATIVE_INFINITY;
    /** Until then a reading may still predate the last command's effect: no drift correction, no external actions. */
    private settleUntilMs = Number.NEGATIVE_INFINITY;
    private commanded = false;
    /** takeover('track-changed'): the listener took Music elsewhere, so this controller never commands it again. */
    private trackChanged = false;
    /** takeover('engine-stopped'): cleared as soon as this controller plays Music again. */
    private engineStopped = false;

    /** Start hold: engine states only feed the audible check until the hold is released or aborted. */
    private held = false;
    private audible: AudibleWait | null = null;
    /** The start's play was sent and has not been rejected, so Music may be playing this track. */
    private startPlayLive = false;

    /** Set before the controller touches the carrier itself; the matching event only clears it. */
    private internalSeek = false;
    private internalPause = false;
    private internalPlay = false;

    constructor(options: ExternalPlaybackSyncOptions) {
        this.engine = options.engine;
        this.song = options.song;
        this.carrier = options.carrier;
        this.mediaId = options.song.sourceRef?.kind === 'online' ? options.song.sourceRef.mediaId : null;
        this.now = options.now ?? Date.now;
        this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
        this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
        this.onHoldReleased = options.onHoldReleased;
        this.onIssue = options.onIssue;
    }

    // 'play' sends play from the carrier position and holds until Music is audible; 'idle' sends nothing.
    start(intent: 'play' | 'idle'): void {
        if (this.disposed || this.started) return;
        this.started = true;
        // The command goes out before subscribing so any reading taken before it is already stale.
        if (intent === 'play') this.beginStartHold();
        this.carrier.addEventListener('play', this.handleCarrierPlay);
        this.carrier.addEventListener('pause', this.handleCarrierPause);
        this.carrier.addEventListener('seeked', this.handleCarrierSeeked);
        this.unsubscribe = this.engine.subscribeState(this.handleEngineState);
    }

    // The listener paused during the start hold: drop the hold without releasing it and pause what was started.
    abortStart(): void {
        if (this.disposed || !this.held) return;
        if (this.audible?.mode === 'start') this.endAudibleWait();
        this.held = false;
        if (this.startPlayLive) this.sendPause();
    }

    // Stops listening; Music is stopped only when asked, when this controller drove it, and nobody took it over.
    async dispose(options: { stopEngine: boolean }): Promise<void> {
        if (this.disposed) return;
        this.disposed = true;
        this.unsubscribe?.();
        this.unsubscribe = null;
        if (this.started) {
            this.carrier.removeEventListener('play', this.handleCarrierPlay);
            this.carrier.removeEventListener('pause', this.handleCarrierPause);
            this.carrier.removeEventListener('seeked', this.handleCarrierSeeked);
        }
        this.endAudibleWait();
        this.carrier.playbackRate = 1;
        if (!options.stopEngine || !this.commanded || this.trackChanged || this.engineStopped) return;
        try {
            await invoke(() => this.engine.stop());
        } catch {
            // The session has moved on to another song; a failure here has nobody left to report to.
        }
    }

    // --- waiting for Music to become audible ---

    private beginStartHold(): void {
        this.held = true;
        const wait = this.beginAudibleWait('start', toEnginePosition(this.carrier.currentTime));
        this.startPlayLive = true;
        this.sendPlay(wait.targetPos).catch((error: unknown) => {
            this.startPlayLive = false;
            if (this.disposed || this.audible !== wait) return;
            this.endAudibleWait();
            this.onIssue({ kind: 'failure', error });
        });
    }

    // A play from a listener action while the carrier already runs: it crawls at the hold rate until Music is audible.
    private playWithRateHold(positionSec: number): void {
        const wait = this.beginAudibleWait('rate', toEnginePosition(positionSec));
        this.carrier.playbackRate = SYNC_HOLD_RATE;
        this.sendPlay(wait.targetPos).catch((error: unknown) => {
            if (this.audible === wait) this.cancelRateHold();
            this.reportFailure(error);
        });
    }

    private beginAudibleWait(mode: AudibleWait['mode'], targetPos: number): AudibleWait {
        this.endAudibleWait();
        const wait: AudibleWait = { mode, targetPos, firstPlayingPos: null, reseekSent: false, timer: null };
        wait.timer = this.setTimer(() => this.handleAudibleTimeout(wait), SYNC_START_TIMEOUT_MS);
        this.audible = wait;
        return wait;
    }

    private endAudibleWait(): void {
        if (!this.audible) return;
        this.clearTimer(this.audible.timer);
        this.audible = null;
    }

    private cancelRateHold(): void {
        if (this.audible?.mode !== 'rate') return;
        this.endAudibleWait();
        this.carrier.playbackRate = 1;
    }

    private handleAudibleTimeout(wait: AudibleWait): void {
        if (this.disposed || this.audible !== wait) return;
        this.audible = null;
        if (wait.mode === 'rate') this.carrier.playbackRate = 1;
        this.onIssue({
            kind: 'failure',
            error: new OnlineProviderError('not-playable', 'Music did not become audible within 8 s', PROVIDER_ID),
        });
    }

    // Music reports 'playing' about 1.5 s before its position moves, so only an advancing position counts as audible.
    // Audible but far from where it was asked to play: re-seek once and keep waiting; otherwise align and release.
    private advanceAudibleWait(state: OmniExternalPlaybackState): void {
        const wait = this.audible;
        if (!wait || state.state !== 'playing' || !this.isOurTrack(state.mediaId)) return;
        if (wait.firstPlayingPos === null) {
            wait.firstPlayingPos = state.positionSec;
            return;
        }
        if (state.positionSec - wait.firstPlayingPos < SYNC_START_ADVANCE_SEC) return;
        const estimate = this.estimate(state);
        if (Math.abs(estimate - wait.targetPos) > SYNC_DRIFT_SEEK_SEC && !wait.reseekSent) {
            wait.reseekSent = true;
            wait.firstPlayingPos = null;
            this.sendSeek(wait.targetPos);
            return;
        }
        this.seekCarrier(estimate);
        this.endAudibleWait();
        if (wait.mode === 'rate') {
            this.carrier.playbackRate = 1;
            return;
        }
        this.held = false;
        this.onHoldReleased();
    }

    // --- engine states ---

    // Drops readings taken before the last command, then routes a fresh one by track and player state.
    private readonly handleEngineState = (state: OmniExternalPlaybackState): void => {
        if (this.disposed || this.trackChanged) return;
        if (state.sampledAtMs < this.lastCommandAtMs) return;
        this.known = { state: state.state, mediaId: state.mediaId };
        if (this.held) {
            this.advanceAudibleWait(state);
            return;
        }
        if (state.state === 'stopped') this.handleEngineStopped();
        else if (!this.isOurTrack(state.mediaId)) this.handleOtherTrack();
        else if (state.state === 'paused') this.handlePausedInMusic();
        else this.followPlaying(state);
    };

    // Same track playing: follow a resume made in Music, finish a rate hold, or steer the carrier toward Music.
    private followPlaying(state: OmniExternalPlaybackState): void {
        if (this.carrier.paused) {
            if (this.isSettling() || this.isCarrierEnded()) return;
            this.playCarrier();
        }
        if (this.audible) {
            this.advanceAudibleWait(state);   // the rate hold owns playbackRate until it releases
            return;
        }
        if (this.isSettling()) return;   // positions jitter for about 1 s after a command
        this.correctDrift(this.estimate(state));
    }

    // Under 80 ms is left alone, up to 1 s is absorbed by a ±5 % rate, beyond that the carrier jumps.
    private correctDrift(estimate: number): void {
        const drift = estimate - this.carrier.currentTime;
        const magnitude = Math.abs(drift);
        if (magnitude < SYNC_DRIFT_IGNORE_SEC) {
            this.carrier.playbackRate = 1;
        } else if (magnitude <= SYNC_DRIFT_SEEK_SEC) {
            this.carrier.playbackRate = 1 + Math.sign(drift) * SYNC_RATE_NUDGE;
        } else {
            this.seekCarrier(estimate);
            this.carrier.playbackRate = 1;
        }
    }

    // Same track paused under a playing carrier, outside the settle window: the listener paused in Music.
    private handlePausedInMusic(): void {
        if (!this.carrier.paused && !this.isSettling()) this.pauseCarrier();
    }

    // Another track in Music. At the carrier's end it is Music auto-advancing (it ignores "play once"), so pause it,
    // even inside the settle window. Earlier, and outside the window, it is the listener taking over. Before this
    // controller is engaged (no command sent, carrier paused) it is just the listener's own playback.
    private handleOtherTrack(): void {
        if (!this.commanded && this.carrier.paused) return;
        if (this.remainingSec() < SYNC_END_GRACE_SEC) {
            this.sendPause();
            return;
        }
        if (this.isSettling()) return;
        this.trackChanged = true;
        this.pauseCarrier();
        this.onIssue({ kind: 'takeover', reason: 'track-changed' });
    }

    // Music stopped under a playing carrier: near the end the track simply ran out; earlier, and outside the settle
    // window, it was stopped externally, so the carrier pauses and the next listener play starts Music again.
    private handleEngineStopped(): void {
        if (this.carrier.paused || this.remainingSec() <= SYNC_END_GRACE_SEC || this.isSettling()) return;
        this.engineStopped = true;
        this.pauseCarrier();
        this.onIssue({ kind: 'takeover', reason: 'engine-stopped' });
    }

    // --- carrier events ---

    // Listener play: nothing if Music already plays this track, resume if it is paused on it, otherwise play from here.
    private readonly handleCarrierPlay = (): void => {
        if (this.internalPlay) {
            this.internalPlay = false;
            return;
        }
        if (!this.canCommand()) return;
        if (this.knownOnOurTrack('playing')) return;
        if (this.knownOnOurTrack('paused')) {
            this.sendResume();
            return;
        }
        this.playWithRateHold(this.carrier.currentTime);
    };

    private readonly handleCarrierPause = (): void => {
        if (this.internalPause) {
            this.internalPause = false;
            return;
        }
        this.cancelRateHold();
        if (!this.canCommand()) return;
        this.sendPause();
    };

    // Listener seek: seek Music while it is on this track. Otherwise (stopped, another track, a loop wrapping back)
    // a playing carrier plays Music from here, and a paused one leaves it for the next play to carry the position.
    private readonly handleCarrierSeeked = (): void => {
        if (this.internalSeek) {
            this.internalSeek = false;
            return;
        }
        if (!this.canCommand()) return;
        const position = this.carrier.currentTime;
        if (this.audible) {
            this.audible.targetPos = toEnginePosition(position);
            this.audible.firstPlayingPos = null;
        }
        const onOurTrack = this.known !== null && this.known.state !== 'stopped' && this.isOurTrack(this.known.mediaId);
        if (onOurTrack) this.sendSeek(position);
        else if (!this.carrier.paused) this.playWithRateHold(position);
    };

    // --- commands to Music ---

    // Every command makes earlier readings stale and opens the settle window.
    private markCommand(): void {
        const at = this.now();
        this.lastCommandAtMs = at;
        this.settleUntilMs = at + SYNC_SETTLE_MS;
        this.commanded = true;
    }

    // Plays this song and assumes Music is now on it; a rejection drops that assumption so the next play retries.
    private sendPlay(positionSec: number): Promise<void> {
        const position = toEnginePosition(positionSec);
        this.markCommand();
        this.engineStopped = false;
        const assumed: KnownEngineState = { state: 'playing', mediaId: this.mediaId };
        this.known = assumed;
        return invoke(() => this.engine.play(this.song, position)).catch((error: unknown) => {
            if (this.known === assumed) this.known = null;
            throw error;
        });
    }

    private sendPause(): void {
        this.markCommand();
        if (this.known?.state === 'playing') this.known = { ...this.known, state: 'paused' };
        invoke(() => this.engine.pause()).catch(this.reportFailure);
    }

    private sendResume(): void {
        this.markCommand();
        if (this.known?.state === 'paused') this.known = { ...this.known, state: 'playing' };
        invoke(() => this.engine.resume()).catch(this.reportFailure);
    }

    private sendSeek(positionSec: number): void {
        const position = toEnginePosition(positionSec);
        this.markCommand();
        invoke(() => this.engine.seek(position)).catch(this.reportFailure);
    }

    private readonly reportFailure = (error: unknown): void => {
        if (this.disposed || this.trackChanged) return;
        this.onIssue({ kind: 'failure', error });
    };

    // --- carrier operations made by the controller ---

    private seekCarrier(positionSec: number): void {
        if (!Number.isFinite(positionSec)) return;
        this.internalSeek = true;
        this.carrier.currentTime = Math.max(0, positionSec);
    }

    private pauseCarrier(): void {
        this.cancelRateHold();
        if (this.carrier.paused) return;
        this.internalPause = true;
        this.carrier.pause();
    }

    private playCarrier(): void {
        if (!this.carrier.paused) return;
        this.internalPlay = true;
        // A refused play fires no event, so the marker must not linger and swallow the listener's next play.
        this.carrier.play().catch(() => { this.internalPlay = false; });
    }

    // --- helpers ---

    private canCommand(): boolean {
        return !this.disposed && !this.trackChanged;
    }

    private isSettling(): boolean {
        return this.now() < this.settleUntilMs;
    }

    private isOurTrack(mediaId: string | null): boolean {
        return this.mediaId !== null && mediaId === this.mediaId;
    }

    private knownOnOurTrack(state: 'playing' | 'paused'): boolean {
        return this.known !== null && this.known.state === state && this.isOurTrack(this.known.mediaId);
    }

    // A playing reading moves on from the moment it was sampled; any other reading stands still.
    private estimate(state: OmniExternalPlaybackState): number {
        if (state.state !== 'playing') return state.positionSec;
        return state.positionSec + (this.now() - state.sampledAtMs) / 1000;
    }

    private remainingSec(): number {
        const { duration, currentTime } = this.carrier;
        return Number.isFinite(duration) ? duration - currentTime : Number.POSITIVE_INFINITY;
    }

    // The carrier interface carries no `ended`; a media element that ran out sits at its duration.
    private isCarrierEnded(): boolean {
        return this.remainingSec() <= 0;
    }
}
