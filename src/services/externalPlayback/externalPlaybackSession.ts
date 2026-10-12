import { PlayerState, type SongResult } from '../../types';
import { OnlineProviderError, type OmniExternalPlaybackEngine } from '../../types/onlineMusic';
import { getPlaybackSongKey } from '../../utils/appPlaybackGuards';
import {
    ExternalPlaybackSync,
    type ExternalPlaybackCarrier,
    type ExternalPlaybackIssue,
    type ExternalPlaybackSyncOptions,
} from './externalPlaybackSync';

// src/services/externalPlayback/externalPlaybackSession.ts
// Carries the per-song ExternalPlaybackSync across track changes: holds autoplay for a new external song until
// Music is audible, creates, starts, replaces and disposes the controllers, keeps the engine monitored while an
// external song is current, and mirrors Folia's volume to it.

/** Trailing throttle for the volume mirror: a dragged slider sends at most one command per window. */
export const EXTERNAL_VOLUME_THROTTLE_MS = 100;

export interface ExternalPlaybackSessionInput {
    song: SongResult | null;
    audioSrc: string | null;
    carrier: (ExternalPlaybackCarrier & { readyState: number; addEventListener(type: 'loadedmetadata', l: () => void): void;
        removeEventListener(type: 'loadedmetadata', l: () => void): void }) | null;
    playerState: PlayerState;
    wantsAutoplay: boolean;
    /** The same gate the audio bridge's autoplay waits on: Music is not started before the lyrics are in. */
    isLyricsLoading: boolean;
}

export interface ExternalPlaybackSessionDeps {
    isExternal(song: SongResult | null | undefined): boolean;
    getEngine(song: SongResult): OmniExternalPlaybackEngine | null;
    createSync?(options: ExternalPlaybackSyncOptions): ExternalPlaybackSync;   // 测试注入点
    clearAutoplayIntent(): void;
    /** Puts the playback store in PAUSED (a held start that failed never ran its carrier, so no pause event does it). */
    setPaused(): void;
    onIssue(issue: ExternalPlaybackIssue): void;
    now?: () => number;
}

type SessionCarrier = NonNullable<ExternalPlaybackSessionInput['carrier']>;

/** One external song on one carrier, and the controller currently syncing them. */
interface Attachment {
    key: string;
    song: SongResult;
    carrier: SessionCarrier;
    engine: OmniExternalPlaybackEngine;
    sync: ExternalPlaybackSync | null;
    /** What the next start asks for; a pause during the hold turns 'play' into 'idle' before a deferred start. */
    intent: 'play' | 'idle';
    /** The current sync was started; a deferred start waits for the carrier's metadata and, for 'play', the lyrics. */
    started: boolean;
    metadataReady: boolean;
    /** Whether the carrier was playing as of its last dispatched play / pause event. */
    carrierPlaying: boolean;
    /** Removes a carrier listener still waiting to start or re-attach a controller. */
    cleanup: (() => void) | null;
    /** Removes the session's own play / pause watch on the carrier. */
    unwatch: () => void;
}

const toSessionKey = (song: SongResult | null, audioSrc: string | null): string | null => (
    song && audioSrc ? `${getPlaybackSongKey(song)}|${audioSrc}` : null
);

// Runs an engine command so a synchronous throw arrives as a rejection like every other failure.
const invoke = (command: () => Promise<void>): Promise<void> => {
    try {
        return Promise.resolve(command());
    } catch (error) {
        return Promise.reject(error);
    }
};

// Refused while Music is not running; the next play or volume change sends it again, so the refusal is dropped.
const sendVolume = (engine: OmniExternalPlaybackEngine, volume: number): void => {
    invoke(() => engine.setVolume(volume)).catch(() => undefined);
};

export class ExternalPlaybackSession {
    private readonly deps: ExternalPlaybackSessionDeps;
    private readonly createSync: (options: ExternalPlaybackSyncOptions) => ExternalPlaybackSync;
    private readonly listeners = new Set<() => void>();
    private version = 0;

    private key: string | null = null;
    private carrier: SessionCarrier | null = null;
    private attachment: Attachment | null = null;
    /** The key whose autoplay hold is over (released by Music becoming audible, an idle start, a pause or a failure). */
    private releasedKey: string | null = null;
    private lastPlayerState: PlayerState | null = null;
    private lyricsLoading = false;

    /** The engine of the current external song, or null while the current song plays in Folia itself. */
    private monitoredEngine: OmniExternalPlaybackEngine | null = null;
    /** The output volume syncOutputGain last applied, whichever song was current. */
    private lastVolume: number | null = null;
    private volumeTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(deps: ExternalPlaybackSessionDeps) {
        this.deps = deps;
        this.createSync = deps.createSync ?? (options => new ExternalPlaybackSync(options));
    }

    // Follows the playback store: a new song or carrier swaps the controller, a pause during the hold aborts the start.
    update(input: ExternalPlaybackSessionInput): void {
        const { song, audioSrc, carrier, playerState } = input;
        const key = toSessionKey(song, audioSrc);
        const external = this.deps.isExternal(song);
        this.lyricsLoading = input.isLyricsLoading;

        if (key !== this.key || carrier !== this.carrier) {
            // The old controller lets go of the carrier first: its dispose resets playbackRate on it.
            this.detach(!external);
            this.key = key;
            this.carrier = carrier;
            this.setMonitoredEngine(external && song ? this.deps.getEngine(song) : null);
            if (external && song && key && carrier) this.attach(song, carrier, key, input.wantsAutoplay ? 'play' : 'idle');
        } else {
            if (playerState === PlayerState.PAUSED && this.lastPlayerState !== PlayerState.PAUSED) this.abortHold();
            // The lyrics may have finished loading since the last update.
            if (this.attachment) this.tryBegin(this.attachment);
        }
        this.lastPlayerState = playerState;
    }

    // Computed in render, so the audio bridge holds a new external source on the very first effect that sees it.
    isAutoplayHeld(song: SongResult | null, audioSrc: string | null): boolean {
        return this.deps.isExternal(song) && audioSrc !== null && toSessionKey(song, audioSrc) !== this.releasedKey;
    }

    readonly subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    };

    readonly getVersion = (): number => this.version;

    // Sends the latest volume at the end of each throttle window, only while the current song plays in Music.
    readonly mirrorVolume = (volume: number): void => {
        this.lastVolume = volume;
        if (!this.monitoredEngine || this.volumeTimer !== null) return;
        this.volumeTimer = setTimeout(() => {
            this.volumeTimer = null;
            if (this.monitoredEngine && this.lastVolume !== null) sendVolume(this.monitoredEngine, this.lastVolume);
        }, EXTERNAL_VOLUME_THROTTLE_MS);
    };

    // Lets go of everything; a later update starts over, which is what StrictMode's effect re-run relies on.
    dispose(): void {
        this.detach(true);
        this.setMonitoredEngine(null);
        if (this.volumeTimer !== null) clearTimeout(this.volumeTimer);
        this.volumeTimer = null;
        this.key = null;
        this.carrier = null;
        this.lastPlayerState = null;
        this.releasedKey = null;
    }

    private attach(song: SongResult, carrier: SessionCarrier, key: string, intent: 'play' | 'idle'): void {
        const engine = this.deps.getEngine(song);
        if (!engine) return;
        const attachment: Attachment = {
            key, song, carrier, engine, intent,
            sync: null,
            started: false,
            metadataReady: false,
            carrierPlaying: !carrier.paused,
            cleanup: null,
            unwatch: () => undefined,
        };
        // Tells whether a pause event is still on its way when a controller has to be replaced (see settleCarrierPause).
        const onPlay = () => { attachment.carrierPlaying = true; };
        const onPause = () => { attachment.carrierPlaying = false; };
        carrier.addEventListener('play', onPlay);
        carrier.addEventListener('pause', onPause);
        attachment.unwatch = () => {
            carrier.removeEventListener('play', onPlay);
            carrier.removeEventListener('pause', onPause);
        };
        this.attachment = attachment;
        // Nothing to hold when nobody asked to play: the listener's own play starts Music later.
        if (intent === 'idle') this.release(key);
        this.startSync(attachment);
    }

    // Creates the controller now and starts it once the carrier knows its duration (the start reads its position).
    private startSync(attachment: Attachment): void {
        const sync = this.createSync({
            engine: attachment.engine,
            song: attachment.song,
            carrier: attachment.carrier,
            now: this.deps.now,
            onHoldReleased: () => {
                if (this.isCurrent(attachment, sync)) this.release(attachment.key);
            },
            // Routed first, while the playback store still describes the moment of the issue. A failed controller is
            // inert and one whose song the listener changed in Music never commands it again, so both are replaced; an
            // engine-stopped one stays, it plays Music again on the listener's next play.
            onIssue: (issue) => {
                if (!this.isCurrent(attachment, sync)) return;
                this.deps.onIssue(issue);
                if (!this.isCurrent(attachment, sync)) return;
                if (issue.kind === 'failure') this.replaceFailedSync(attachment, sync);
                else if (issue.reason === 'track-changed') this.replaceSync(attachment, sync, false);
            },
        });
        attachment.sync = sync;
        attachment.started = false;
        const { carrier } = attachment;
        attachment.metadataReady = carrier.readyState >= 1;
        if (!attachment.metadataReady) {
            const onReady = () => {
                carrier.removeEventListener('loadedmetadata', onReady);
                attachment.cleanup = null;
                if (!this.isCurrent(attachment, sync)) return;
                attachment.metadataReady = true;
                this.tryBegin(attachment);
            };
            carrier.addEventListener('loadedmetadata', onReady);
            attachment.cleanup = () => carrier.removeEventListener('loadedmetadata', onReady);
        }
        this.tryBegin(attachment);
    }

    // Starts the current controller once the carrier has metadata and, for a play start, the lyrics have loaded (the
    // audio bridge's own autoplay gate). The volume goes out right behind a start's play, so Music has it (a muted
    // Folia included) before it is audible rather than only once the hold lifts. An idle start sends nothing: Music
    // may be playing the listener's own music.
    private tryBegin(attachment: Attachment): void {
        const { sync } = attachment;
        if (!sync || attachment.started || !attachment.metadataReady) return;
        if (attachment.intent === 'play' && this.lyricsLoading) return;
        attachment.started = true;
        sync.start(attachment.intent);
        if (attachment.intent === 'play' && this.lastVolume !== null) sendVolume(attachment.engine, this.lastVolume);
    }

    // A failed controller is inert (a failed start never leaves its hold), so it is replaced by an idle one that lets
    // the listener's next play retry; the failed one stops what it started in Music. A held autoplay is handed back so
    // the bridge neither plays the carrier nor keeps showing it as playing, and the store goes to PAUSED: that carrier
    // never ran, so no pause event will put it there, whichever way the issue was routed.
    private replaceFailedSync(attachment: Attachment, failed: ExternalPlaybackSync): void {
        const held = attachment.key !== this.releasedKey;
        this.replaceSync(attachment, failed, true);
        if (!held) return;
        this.deps.clearAutoplayIntent();
        this.release(attachment.key);
        this.deps.setPaused();
    }

    // Swaps a controller for a fresh idle one on the same song and carrier. A running carrier is paused, and the fresh
    // controller attaches only after the old one's dispose settled (a stop included) and any pause event still on its
    // way has passed, so neither a reading from before the stop nor that pause is taken for something the listener did.
    private replaceSync(attachment: Attachment, old: ExternalPlaybackSync, stopEngine: boolean): void {
        attachment.sync = null;
        attachment.started = false;
        attachment.intent = 'idle';
        attachment.cleanup?.();
        attachment.cleanup = null;
        const settled: Promise<unknown>[] = [Promise.resolve(old.dispose({ stopEngine }))];
        const paused = this.settleCarrierPause(attachment);
        if (paused) settled.push(paused);
        void Promise.all(settled).then(() => {
            if (this.attachment !== attachment || attachment.sync !== null) return;
            attachment.cleanup = null;
            this.startSync(attachment);
        });
    }

    // Pauses a running carrier and resolves on its pause event. A carrier already paused while its last dispatched
    // event was 'play' (the controller paused it a moment ago) still has that event coming, so it is waited for too.
    // Null when no pause event is on its way.
    private settleCarrierPause(attachment: Attachment): Promise<void> | null {
        const { carrier } = attachment;
        if (carrier.paused && !attachment.carrierPlaying) return null;
        const settled = new Promise<void>((resolve) => {
            const onPaused = () => {
                carrier.removeEventListener('pause', onPaused);
                resolve();
            };
            carrier.addEventListener('pause', onPaused);
            attachment.cleanup = () => carrier.removeEventListener('pause', onPaused);
        });
        if (!carrier.paused) carrier.pause();
        return settled;
    }

    // The listener paused while Music was still becoming audible (or before it was asked to play, while the lyrics
    // loaded): pause what was started, give up the autoplay, and let a deferred start go out as idle.
    private abortHold(): void {
        const attachment = this.attachment;
        if (!attachment || attachment.key === this.releasedKey) return;
        attachment.intent = 'idle';
        if (attachment.started) attachment.sync?.abortStart();
        this.deps.clearAutoplayIntent();
        this.release(attachment.key);
        this.tryBegin(attachment);
    }

    private detach(stopEngine: boolean): void {
        const attachment = this.attachment;
        if (!attachment) return;
        this.attachment = null;
        attachment.unwatch();
        attachment.cleanup?.();
        attachment.cleanup = null;
        const { sync } = attachment;
        attachment.sync = null;
        if (sync) void sync.dispose({ stopEngine });
    }

    // Monitoring follows the current song's engine; consecutive external songs on the same engine keep it on.
    private setMonitoredEngine(engine: OmniExternalPlaybackEngine | null): void {
        if (engine === this.monitoredEngine) return;
        this.monitoredEngine?.setMonitoring(false);
        this.monitoredEngine = engine;
        engine?.setMonitoring(true);
    }

    private isCurrent(attachment: Attachment, sync: ExternalPlaybackSync): boolean {
        return this.attachment === attachment && attachment.sync === sync;
    }

    private release(key: string): void {
        if (this.releasedKey === key) return;
        this.releasedKey = key;
        this.version += 1;
        for (const listener of [...this.listeners]) listener();
    }
}

export interface ExternalPlaybackIssueRoute {
    /** The playback store's state at the moment the issue arrives. */
    playerState: PlayerState;
    setPaused(): void;
    showStatus(type: 'info' | 'error', key: string): void;
    /** The queue's failure skip, as for a source that failed to load. */
    onPlaybackFailure(): void;
}

// Turns a controller issue into what the listener sees. Takeovers only inform. A denied permission pauses with the
// hint and never skips, or every Apple song in the queue would be skipped in turn. A failure that arrives after the
// listener paused (or Music was paused under a hold) stays paused. Anything else skips like a broken source.
export const routeExternalPlaybackIssue = (issue: ExternalPlaybackIssue, route: ExternalPlaybackIssueRoute): void => {
    if (issue.kind === 'takeover') {
        route.showStatus('info', issue.reason === 'track-changed' ? 'appleMusic.takeover' : 'appleMusic.engineStopped');
        return;
    }
    if (issue.error instanceof OnlineProviderError && issue.error.code === 'auth-required') {
        route.setPaused();
        route.showStatus('error', 'appleMusic.permissionDenied');
        return;
    }
    if (route.playerState === PlayerState.PAUSED) {
        route.setPaused();
        return;
    }
    route.showStatus('error', 'appleMusic.playFailed');
    route.onPlaybackFailure();
};
