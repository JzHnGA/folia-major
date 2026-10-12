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
}

export interface ExternalPlaybackSessionDeps {
    isExternal(song: SongResult | null | undefined): boolean;
    getEngine(song: SongResult): OmniExternalPlaybackEngine | null;
    createSync?(options: ExternalPlaybackSyncOptions): ExternalPlaybackSync;   // 测试注入点
    clearAutoplayIntent(): void;
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
    /** Removes a carrier listener still waiting to start or re-attach a controller. */
    cleanup: (() => void) | null;
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

        if (key !== this.key || carrier !== this.carrier) {
            // The old controller lets go of the carrier first: its dispose resets playbackRate on it.
            this.detach(!external);
            this.key = key;
            this.carrier = carrier;
            this.setMonitoredEngine(external && song ? this.deps.getEngine(song) : null);
            if (external && song && key && carrier) this.attach(song, carrier, key, input.wantsAutoplay ? 'play' : 'idle');
        } else if (playerState === PlayerState.PAUSED && this.lastPlayerState !== PlayerState.PAUSED) {
            this.abortHold();
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
        const attachment: Attachment = { key, song, carrier, engine, sync: null, intent, cleanup: null };
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
            // Routed first, while the playback store still describes the moment of the issue.
            onIssue: (issue) => {
                if (!this.isCurrent(attachment, sync)) return;
                this.deps.onIssue(issue);
                if (issue.kind === 'failure' && this.isCurrent(attachment, sync)) this.replaceFailedSync(attachment, sync);
            },
        });
        attachment.sync = sync;
        const { carrier } = attachment;
        if (carrier.readyState >= 1) {
            this.begin(attachment, sync);
            return;
        }
        const onReady = () => {
            carrier.removeEventListener('loadedmetadata', onReady);
            attachment.cleanup = null;
            if (this.isCurrent(attachment, sync)) this.begin(attachment, sync);
        };
        carrier.addEventListener('loadedmetadata', onReady);
        attachment.cleanup = () => carrier.removeEventListener('loadedmetadata', onReady);
    }

    // The volume goes out right behind a start's play, so Music has it (a muted Folia included) before it is audible
    // rather than only once the hold lifts. An idle start sends nothing: Music may be playing the listener's own music.
    private begin(attachment: Attachment, sync: ExternalPlaybackSync): void {
        sync.start(attachment.intent);
        if (attachment.intent === 'play' && this.lastVolume !== null) sendVolume(attachment.engine, this.lastVolume);
    }

    // A failed controller is inert (a failed start never leaves its hold), so it is replaced by an idle one that lets
    // the listener's next play retry. The failed one stops what it started in Music, a running carrier is paused, and a
    // held autoplay is handed back so the bridge neither plays the carrier nor shows it as playing. The fresh controller
    // attaches only after Music was told to stop and the carrier's own pause event has passed, so neither a reading from
    // before the stop nor that pause is taken for something the listener did.
    private replaceFailedSync(attachment: Attachment, failed: ExternalPlaybackSync): void {
        attachment.sync = null;
        attachment.intent = 'idle';
        attachment.cleanup?.();
        attachment.cleanup = null;
        const settled: Promise<unknown>[] = [Promise.resolve(failed.dispose({ stopEngine: true }))];
        const { carrier } = attachment;
        if (!carrier.paused) {
            settled.push(new Promise<void>((resolve) => {
                const onPaused = () => {
                    carrier.removeEventListener('pause', onPaused);
                    resolve();
                };
                carrier.addEventListener('pause', onPaused);
                attachment.cleanup = () => carrier.removeEventListener('pause', onPaused);
            }));
            carrier.pause();
        }
        if (attachment.key !== this.releasedKey) {
            this.deps.clearAutoplayIntent();
            this.release(attachment.key);
        }
        void Promise.all(settled).then(() => {
            if (this.attachment !== attachment || attachment.sync !== null) return;
            attachment.cleanup = null;
            this.startSync(attachment);
        });
    }

    // The listener paused while Music was still becoming audible: pause what was started and give up the autoplay.
    private abortHold(): void {
        const attachment = this.attachment;
        if (!attachment || attachment.key === this.releasedKey) return;
        attachment.intent = 'idle';
        attachment.sync?.abortStart();
        this.deps.clearAutoplayIntent();
        this.release(attachment.key);
    }

    private detach(stopEngine: boolean): void {
        const attachment = this.attachment;
        if (!attachment) return;
        this.attachment = null;
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
