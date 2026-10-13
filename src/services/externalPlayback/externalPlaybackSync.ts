import type { SongResult } from '../../types';
import {
    OnlineProviderError,
    type OmniExternalPlaybackEngine,
    type OmniExternalPlaybackState,
} from '../../types/onlineMusic';

// src/services/externalPlayback/externalPlaybackSync.ts
// Keeps one song's silent carrier <audio> and Music.app in lock-step: the listener's play / pause / seek on the
// carrier are mirrored to Music, and the carrier's clock is steered from Music's reported position.

export const SYNC_DRIFT_IGNORE_SEC = 0.03;
export const SYNC_DRIFT_SEEK_SEC = 1;
export const SYNC_RATE_NUDGE = 0.05;
export const SYNC_START_TIMEOUT_MS = 8000;
export const SYNC_END_GRACE_SEC = 1.5;
export const SYNC_SETTLE_MS = 1000;
export const SYNC_START_ADVANCE_SEC = 0.05;
/** Chromium's minimum playbackRate: the carrier crawls at it while Music buffers after a play outside the start hold. */
export const SYNC_HOLD_RATE = 0.0625;
/** Music's crossfade / AutoMix starts its next track up to this long before ours ends (its longest crossfade). */
export const SYNC_MUSIC_TRANSITION_WINDOW_SEC = 12;

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
    /** First playing reading of this track that the advance is measured from. */
    anchor: { positionSec: number; sampledAtMs: number } | null;
    reseekSent: boolean;
    timer: unknown;
}

/** How far past the elapsed sample time a reading may run ahead of the anchor before the pair is not trusted. */
const AUDIBLE_ANCHOR_SLACK_SEC = 0.3;

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
    /** When the carrier last ran out (its end-of-media pause), for the auto-advance grace after it. */
    private carrierEndedAtMs: number | null = null;
    /** Foreign tracks already paused as an auto-advance since this controller last played Music. */
    private readonly autoAdvancePaused = new Set<string>();
    /**
     * Music's own timeline for this track: its last fresh playing reading (duration falling back to the carrier's).
     * Music starts its next track seconds early, so only this, not the carrier, tells that ours ended. Every play of
     * ours forgets it.
     */
    private lastOurReading: { positionSec: number; durationSec: number } | null = null;

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
            this.failAudibleWait(wait, error);
        });
    }

    // A play from a listener action while the carrier already runs: it crawls at the hold rate until Music is audible.
    private playWithRateHold(positionSec: number): void {
        const wait = this.beginAudibleWait('rate', toEnginePosition(positionSec));
        this.carrier.playbackRate = SYNC_HOLD_RATE;
        this.sendPlay(wait.targetPos).catch((error: unknown) => this.failAudibleWait(wait, error));
    }

    // A play rejection is reported only while its own wait is current. The timeout clears the wait when it reports,
    // and a newer play replaces it, so a hung or superseded play never reaches the session a second time.
    private failAudibleWait(wait: AudibleWait, error: unknown): void {
        if (this.disposed || this.audible !== wait) return;
        this.endAudibleWait();
        if (wait.mode === 'rate') this.carrier.playbackRate = 1;
        this.onIssue({ kind: 'failure', error });
    }

    private beginAudibleWait(mode: AudibleWait['mode'], targetPos: number): AudibleWait {
        this.endAudibleWait();
        const wait: AudibleWait = { mode, targetPos, anchor: null, reseekSent: false, timer: null };
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
    // A reading that went backwards from the anchor, or ran further ahead than the time between the two samples
    // allows, means one of them predates the play: it becomes the new anchor instead of proving anything.
    // Audible but far from where it was asked to play: re-seek once and keep waiting; otherwise align and release.
    private advanceAudibleWait(state: OmniExternalPlaybackState): void {
        const wait = this.audible;
        if (!wait || state.state !== 'playing' || !this.isOurTrack(state.mediaId)) return;
        const anchor = wait.anchor;
        const advance = anchor ? state.positionSec - anchor.positionSec : 0;
        const allowed = anchor ? (state.sampledAtMs - anchor.sampledAtMs) / 1000 + AUDIBLE_ANCHOR_SLACK_SEC : 0;
        if (!anchor || advance < 0 || advance > allowed) {
            wait.anchor = { positionSec: state.positionSec, sampledAtMs: state.sampledAtMs };
            return;
        }
        if (advance < SYNC_START_ADVANCE_SEC) return;
        const estimate = this.estimate(state);
        if (Math.abs(estimate - wait.targetPos) > SYNC_DRIFT_SEEK_SEC && !wait.reseekSent) {
            wait.reseekSent = true;
            wait.anchor = null;
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
        // While Music is still becoming audible (start hold or rate hold) only the audible check runs; the hold
        // timeout guards against Music never getting there.
        if (this.held || this.audible) {
            this.advanceAudibleWait(state);
            return;
        }
        if (state.state === 'stopped') this.handleEngineStopped();
        else if (!this.isOurTrack(state.mediaId)) this.handleOtherTrack(state);
        else if (state.state === 'paused') this.handlePausedInMusic();
        else this.followPlaying(state);
    };

    // Same track playing: follow a resume made in Music, then steer the carrier toward Music.
    private followPlaying(state: OmniExternalPlaybackState): void {
        const durationSec = state.durationSec ?? this.carrier.duration;
        this.lastOurReading = { positionSec: state.positionSec, durationSec };
        if (this.carrier.paused) {
            if (this.isSettling() || this.isCarrierEnded()) return;
            this.playCarrier();
        }
        if (this.isSettling()) return;   // positions jitter for about 1 s after a command
        this.correctDrift(this.estimate(state));
    }

    // Under 30 ms is left alone, up to 1 s is absorbed by a ±5 % rate, beyond that the carrier jumps.
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

    // Another track in Music. Before this controller is engaged (no command sent, carrier paused) it is the
    // listener's own playback. Around the carrier's end it is Music auto-advancing (it ignores "play once"): see
    // pauseAutoAdvance. Once the carrier ended longer ago than the grace, the listener may play anything: ignore it.
    // Otherwise, outside the settle window, it is the listener taking over.
    // Music's crossfade / AutoMix starts its next track seconds before ours ends, while the carrier still has time
    // left: when Music's last reading of ours was that close to its end, ours ended there (see finishWithMusic).
    private handleOtherTrack(state: OmniExternalPlaybackState): void {
        if (!this.commanded && this.carrier.paused) return;
        if (this.isCarrierEnded()) {
            const endedAt = this.carrierEndedAtMs;
            if (endedAt !== null && this.now() - endedAt <= SYNC_END_GRACE_SEC * 1000) this.pauseAutoAdvance(state);
            return;
        }
        if (state.state === 'playing' && this.musicReachedOurEnd()) {
            this.finishWithMusic(state);
            return;
        }
        if (!this.carrier.paused && this.remainingSec() < SYNC_END_GRACE_SEC) {
            this.pauseAutoAdvance(state);
            return;
        }
        if (this.isSettling()) return;
        this.trackChanged = true;
        this.pauseCarrier();
        this.onIssue({ kind: 'takeover', reason: 'track-changed' });
    }

    // Music's last reading of ours was within its crossfade window of the end, under a running carrier. A paused
    // carrier is the listener's pause (or a takeover): finishing it would move Folia's queue on against that pause.
    private musicReachedOurEnd(): boolean {
        const reading = this.lastOurReading;
        if (!reading || this.carrier.paused || !Number.isFinite(this.carrier.duration)) return false;
        return reading.durationSec - reading.positionSec <= SYNC_MUSIC_TRANSITION_WINDOW_SEC;
    }

    // Music moved on into its next track: pause that like any auto-advance (even inside the settle window) and run the
    // carrier out now with an internal seek, so its `ended` moves Folia's queue on and the seek is not sent to Music.
    // The reading is forgotten and the carrier sits at its end, so this happens once per play.
    private finishWithMusic(state: OmniExternalPlaybackState): void {
        this.lastOurReading = null;
        this.pauseAutoAdvance(state);
        this.seekCarrier(this.carrier.duration);
    }

    // Pauses Music's auto-advance into a foreign track, even inside the settle window: only a playing reading, and
    // each foreign track at most once per play of ours, so a listener who deliberately plays it is not fought.
    private pauseAutoAdvance(state: OmniExternalPlaybackState): void {
        if (state.state !== 'playing' || state.mediaId === null || this.autoAdvancePaused.has(state.mediaId)) return;
        this.autoAdvancePaused.add(state.mediaId);
        this.sendPause();
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
        if (this.isCarrierEnded()) this.carrierEndedAtMs = this.now();
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
            this.audible.reseekSent = false;
            this.audible.anchor = null;
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

    // Runs an engine command and, when it settles either way, keeps the settle window open a full second past that
    // moment: a slow command (Music launching cold) takes effect long after it was sent.
    private runCommand(command: () => Promise<void>): Promise<void> {
        const extendSettle = () => {
            this.settleUntilMs = Math.max(this.settleUntilMs, this.now() + SYNC_SETTLE_MS);
        };
        return invoke(command).then(extendSettle, (error: unknown) => {
            extendSettle();
            throw error;
        });
    }

    // Plays this song and assumes Music is now on it; a rejection drops that assumption so the next play retries.
    private sendPlay(positionSec: number): Promise<void> {
        const position = toEnginePosition(positionSec);
        this.markCommand();
        this.engineStopped = false;
        this.autoAdvancePaused.clear();
        this.lastOurReading = null;
        const assumed: KnownEngineState = { state: 'playing', mediaId: this.mediaId };
        this.known = assumed;
        return this.runCommand(() => this.engine.play(this.song, position)).catch((error: unknown) => {
            if (this.known === assumed) this.known = null;
            throw error;
        });
    }

    private sendPause(): void {
        this.markCommand();
        if (this.known?.state === 'playing') this.known = { ...this.known, state: 'paused' };
        this.runCommand(() => this.engine.pause()).catch(this.reportFailure);
    }

    private sendResume(): void {
        this.markCommand();
        if (this.known?.state === 'paused') this.known = { ...this.known, state: 'playing' };
        this.runCommand(() => this.engine.resume()).catch(this.reportFailure);
    }

    private sendSeek(positionSec: number): void {
        const position = toEnginePosition(positionSec);
        this.markCommand();
        this.runCommand(() => this.engine.seek(position)).catch(this.reportFailure);
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
