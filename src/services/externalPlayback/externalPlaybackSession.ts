import { PlayerState, type SongResult } from '../../types';
import { OnlineProviderError, type OmniExternalPlaybackEngine } from '../../types/onlineMusic';
import { getPlaybackSongKey } from '../../utils/appPlaybackGuards';
import type { AutomixDeckId } from '../automix/automixSession';
import type { DeckGainEnvelope } from '../gainEnvelope';
import {
    ExternalPlaybackSync,
    type ExternalPlaybackCarrier,
    type ExternalPlaybackIssue,
    type ExternalPlaybackStartIntent,
    type ExternalPlaybackSyncOptions,
} from './externalPlaybackSync';
import { ExternalVolumeMirror } from './externalVolumeMirror';

// src/services/externalPlayback/externalPlaybackSession.ts
// Carries the per-song ExternalPlaybackSync across track changes: holds autoplay for a new external song until
// Music is audible, creates, starts, replaces and disposes the controllers, keeps the engine monitored while an
// external song is current, and mirrors Folia's volume to it.
// A song is bound to the deck whose src is its carrier, not to the active deck: through an Automix transition the
// fading tail keeps its controller, and an arriving song prerolls Music on the deck Automix still holds.

export { EXTERNAL_VOLUME_THROTTLE_MS } from './externalVolumeMirror';

export interface ExternalPlaybackSessionInput {
    song: SongResult | null;
    audioSrc: string | null;
    carrier: (ExternalPlaybackCarrier & { readyState: number; addEventListener(type: 'loadedmetadata', l: () => void): void;
        removeEventListener(type: 'loadedmetadata', l: () => void): void }) | null;
    playerState: PlayerState;
    wantsAutoplay: boolean;
    /** The same gate the audio bridge's autoplay waits on: Music is not started before the lyrics are in. */
    isLyricsLoading: boolean;
    /** Automix's decks and the source each one renders; without them the song is bound to `carrier`. */
    decks?: readonly ExternalPlaybackDeck[];
    /** Automix's transition from arm to settle: who fades out on which deck, and who arrives on which. */
    transition?: ExternalPlaybackTransition | null;
}

export type ExternalPlaybackSessionCarrier = NonNullable<ExternalPlaybackSessionInput['carrier']>;

export interface ExternalPlaybackDeck {
    id: AutomixDeckId;
    element: ExternalPlaybackSessionCarrier | null;
    src: string | null;
}

export interface ExternalPlaybackTransition {
    tail: { deck: AutomixDeckId; song: SongResult };
    incoming: { deck: AutomixDeckId; song: SongResult };
}

/** The external song the session follows, on the carrier that renders it, and its part in a transition. */
export interface ExternalPlaybackBinding {
    song: SongResult;
    src: string;
    key: string;
    carrier: ExternalPlaybackSessionCarrier;
    deck: AutomixDeckId | null;
    role: 'current' | 'tail' | 'incoming';
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
    /** Makes Automix's armed blend a hard cut (it refuses the blend at its first sound). */
    cutTransition?(): void;
    /** AudioContext.currentTime, null while there is no graph; the mirror reads envelopes on this clock. */
    audioNow?(): number | null;
    createMirror?(): ExternalVolumeMirror;   // 测试注入点
}

/** One external song on one carrier, and the controller currently syncing them. */
interface Attachment {
    key: string;
    song: SongResult;
    carrier: ExternalPlaybackSessionCarrier;
    engine: OmniExternalPlaybackEngine;
    sync: ExternalPlaybackSync | null;
    /** What the next start asks for; a pause during the hold turns 'play' into 'idle' before a deferred start. */
    intent: ExternalPlaybackStartIntent;
    /** Its part in Automix's transition; the binding keeps the attachment while only this changes. */
    role: ExternalPlaybackBinding['role'];
    /** The carrier ran at attach or dispatched a play since: a preroll's carrier then no longer waits on Automix. */
    carrierPlayed: boolean;
    /** cutTransition was already asked for on this attachment's behalf. */
    cutRequested: boolean;
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

const mediaIdOf = (song: SongResult): string | null => (
    song.sourceRef?.kind === 'online' ? song.sourceRef.mediaId : null
);

const toBinding = (
    song: SongResult,
    src: string,
    carrier: ExternalPlaybackSessionCarrier,
    deck: AutomixDeckId | null,
    role: ExternalPlaybackBinding['role'],
): ExternalPlaybackBinding => ({ song, src, key: `${getPlaybackSongKey(song)}|${src}`, carrier, deck, role });

// Binds a song to a deck that renders a source on an element; null when the deck has neither.
const bindToDeck = (
    song: SongResult,
    deck: ExternalPlaybackDeck | null | undefined,
    role: ExternalPlaybackBinding['role'],
): ExternalPlaybackBinding | null => (
    deck?.src && deck.element ? toBinding(song, deck.src, deck.element, deck.id, role) : null
);

// Picks the external song to follow and the carrier that renders it, first match wins: the fading tail of a
// transition, then the arriving song once its deck renders its own source (a deck that still shows the tail's source
// has no preheated carrier yet), then the current song on the deck whose src is its source (or on `carrier` when
// no decks are given).
export const resolveExternalBinding = (
    input: ExternalPlaybackSessionInput,
    isExternal: (song: SongResult | null | undefined) => boolean,
): ExternalPlaybackBinding | null => {
    const { decks, transition, song, audioSrc } = input;
    const deckById = (id: AutomixDeckId) => decks?.find(deck => deck.id === id) ?? null;
    if (transition) {
        const tailDeck = deckById(transition.tail.deck);
        const tail = isExternal(transition.tail.song) ? bindToDeck(transition.tail.song, tailDeck, 'tail') : null;
        if (tail) return tail;
        const incomingDeck = deckById(transition.incoming.deck);
        const incoming = isExternal(transition.incoming.song) && incomingDeck?.src && incomingDeck.src !== tailDeck?.src
            ? bindToDeck(transition.incoming.song, incomingDeck, 'incoming')
            : null;
        if (incoming) return incoming;
    }
    if (!song || !audioSrc || !isExternal(song)) return null;
    if (decks) return bindToDeck(song, decks.find(deck => deck.src === audioSrc), 'current');
    return input.carrier ? toBinding(song, audioSrc, input.carrier, null, 'current') : null;
};

export class ExternalPlaybackSession {
    private readonly deps: ExternalPlaybackSessionDeps;
    private readonly createSync: (options: ExternalPlaybackSyncOptions) => ExternalPlaybackSync;
    /** Plays Folia's volume, Automix's deck envelope and the pause fade on Music; follows the bound song. */
    private readonly mirror: ExternalVolumeMirror;
    private readonly listeners = new Set<() => void>();
    private version = 0;
    private warned = false;

    private key: string | null = null;
    private carrier: ExternalPlaybackSessionCarrier | null = null;
    private attachment: Attachment | null = null;
    /** The key whose autoplay hold is over (released by Music becoming audible, an idle start, a pause or a failure). */
    private releasedKey: string | null = null;
    private lastPlayerState: PlayerState | null = null;
    private lyricsLoading = false;

    /** The engine of the current external song, or null while the current song plays in Folia itself. */
    private monitoredEngine: OmniExternalPlaybackEngine | null = null;

    constructor(deps: ExternalPlaybackSessionDeps) {
        this.deps = deps;
        this.createSync = deps.createSync ?? (options => new ExternalPlaybackSync(options));
        this.mirror = deps.createMirror?.() ?? new ExternalVolumeMirror({
            audioNow: () => deps.audioNow?.() ?? null,
            now: deps.now,
        });
    }

    // Follows the playback store: a new song or carrier swaps the controller, a pause during the hold aborts the start.
    update(input: ExternalPlaybackSessionInput): void {
        const { playerState } = input;
        const binding = resolveExternalBinding(input, song => this.deps.isExternal(song));
        const key = binding?.key ?? null;
        const carrier = binding?.carrier ?? null;
        this.lyricsLoading = input.isLyricsLoading;

        if (key !== this.key || carrier !== this.carrier) {
            // Music keeps playing (no stop) only when the song that follows is external as well.
            const next = binding?.song ?? input.song;
            const external = this.deps.isExternal(next);
            // The old controller lets go of the carrier first: its dispose resets playbackRate on it.
            this.detach(!external);
            this.key = key;
            this.carrier = carrier;
            this.setMonitoredEngine(external && next ? this.deps.getEngine(next) : null);
            if (binding) this.attach(binding, this.startIntentFor(binding, input.wantsAutoplay));
        } else {
            if (this.attachment && binding) this.changeRole(this.attachment, binding.role);
            if (playerState === PlayerState.PAUSED && this.lastPlayerState !== PlayerState.PAUSED) {
                this.abortHold();
                this.abortPreroll();
            }
            // The lyrics may have finished loading since the last update.
            if (this.attachment) this.tryBegin(this.attachment);
        }
        this.lastPlayerState = playerState;
    }

    // Computed in render, so the audio bridge holds a new external source on the very first effect that sees it.
    // Automix's arriving song (incomingSongKey) is never held: its preroll starts Music, Automix starts the carrier.
    isAutoplayHeld(song: SongResult | null, audioSrc: string | null, incomingSongKey?: string | null): boolean {
        if (!this.deps.isExternal(song) || audioSrc === null) return false;
        if (song && incomingSongKey != null && getPlaybackSongKey(song) === incomingSongKey) return false;
        return toSessionKey(song, audioSrc) !== this.releasedKey;
    }

    readonly subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    };

    readonly getVersion = (): number => this.version;

    // Sends the latest volume at the end of each throttle window, only while the current song plays in Music.
    readonly mirrorVolume = (volume: number): void => {
        this.guard(() => this.mirror.setUserVolume(volume));
    };

    // Automix's gain move on a deck; the mirror applies it while the bound song is on that deck.
    handleDeckEnvelope(deck: AutomixDeckId, envelope: DeckGainEnvelope): void {
        this.guard(() => this.mirror.handleDeckEnvelope(deck, envelope));
    }

    // The pause / resume fade, which applies to whichever song is bound.
    handleFadeEnvelope(envelope: DeckGainEnvelope): void {
        this.guard(() => this.mirror.handleFadeEnvelope(envelope));
    }

    // Lets go of everything; a later update starts over, which is what StrictMode's effect re-run relies on.
    dispose(): void {
        this.detach(true);
        this.setMonitoredEngine(null);
        this.guard(() => this.mirror.dispose());
        this.key = null;
        this.carrier = null;
        this.lastPlayerState = null;
        this.releasedKey = null;
    }

    // An arriving song prerolls; a fading tail never starts Music again; otherwise the store's autoplay decides.
    private startIntentFor(binding: ExternalPlaybackBinding, wantsAutoplay: boolean): ExternalPlaybackStartIntent {
        if (binding.role === 'incoming') return 'preroll';
        if (binding.role === 'tail') return 'idle';
        return wantsAutoplay ? 'play' : 'idle';
    }

    private attach(binding: ExternalPlaybackBinding, intent: ExternalPlaybackStartIntent): void {
        const { song, carrier, key } = binding;
        const engine = this.deps.getEngine(song);
        if (!engine) return;
        const attachment: Attachment = {
            key, song, carrier, engine, intent,
            role: binding.role,
            // A binding that appears after Automix started the carrier is past the lead already.
            carrierPlayed: !carrier.paused,
            cutRequested: false,
            sync: null,
            started: false,
            metadataReady: false,
            carrierPlaying: !carrier.paused,
            cleanup: null,
            unwatch: () => undefined,
        };
        // Tells whether a pause event is still on its way when a controller has to be replaced (see settleCarrierPause).
        const onPlay = () => {
            attachment.carrierPlaying = true;
            attachment.carrierPlayed = true;
            this.handleCarrierPlay(attachment);
        };
        const onPause = () => {
            attachment.carrierPlaying = false;
            this.handleCarrierPause(attachment);
        };
        carrier.addEventListener('play', onPlay);
        carrier.addEventListener('pause', onPause);
        attachment.unwatch = () => {
            carrier.removeEventListener('play', onPlay);
            carrier.removeEventListener('pause', onPause);
        };
        this.attachment = attachment;
        this.guard(() => this.mirror.bind({ engine, mediaId: mediaIdOf(song), deck: binding.deck, carrier }));
        // Nothing to hold when nobody asked to play: the listener's own play starts Music later.
        // A preroll is not held either: Automix holds its carrier and starts it itself.
        if (intent !== 'play') this.release(key);
        this.startSync(attachment);
    }

    // Same song on the same carrier, Automix's transition moved around it. Leaving 'incoming' ends the transition
    // into it however it ended (settled, refused or cut alike), so Music leads the position again. 'current' and
    // 'tail' swapping (the advance, or a cancel back to the outgoing song) changes nothing.
    private changeRole(attachment: Attachment, role: ExternalPlaybackBinding['role']): void {
        if (attachment.role === role) return;
        const wasIncoming = attachment.role === 'incoming';
        attachment.role = role;
        if (wasIncoming) attachment.sync?.endTransition();
    }

    // Folia plays the bound song: the mirror drives Music's volume. An arriving song whose carrier Automix starts while
    // Music is still not audible would blend in silence (the tail fading into nothing until the preroll times out), so
    // the blend becomes a hard cut; the controller keeps waiting and aligns Music to the carrier once it sounds.
    private handleCarrierPlay(attachment: Attachment): void {
        this.guard(() => {
            if (this.attachment !== attachment) return;
            this.cutIfPrerollLate(attachment);
            this.mirror.drive();
        });
    }

    // The arriving song's carrier runs while its preroll still waits for Music to sound: ask for the hard cut.
    private cutIfPrerollLate(attachment: Attachment): void {
        if (attachment.role === 'incoming' && attachment.sync?.isPrerollPending()) this.requestCut(attachment);
    }

    private handleCarrierPause(attachment: Attachment): void {
        this.guard(() => {
            if (this.attachment === attachment) this.mirror.yieldControl();
        });
    }

    // Asks Automix for a hard cut at most once per attachment.
    private requestCut(attachment: Attachment): void {
        if (attachment.cutRequested) return;
        attachment.cutRequested = true;
        this.guard(() => this.deps.cutTransition?.());
    }

    // A preroll whose carrier Automix has not started yet.
    private isPrerolling(attachment: Attachment): boolean {
        return attachment.intent === 'preroll' && !attachment.carrierPlayed;
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
            // A preroll that fails while Automix still holds its carrier cuts the blend first, so the outgoing song is
            // not faded into silence. Either way Folia stops driving Music's volume.
            onIssue: (issue) => {
                if (!this.isCurrent(attachment, sync)) return;
                if (issue.kind === 'failure' && this.isPrerolling(attachment)) this.requestCut(attachment);
                this.guard(() => this.mirror.yieldControl());
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
    // A preroll does not wait for the lyrics (Automix times it), and the mirror holds Music at the deck's envelope.
    private tryBegin(attachment: Attachment): void {
        const { sync } = attachment;
        if (!sync || attachment.started || !attachment.metadataReady) return;
        if (attachment.intent === 'play' && this.lyricsLoading) return;
        attachment.started = true;
        sync.start(attachment.intent);
        // A preroll started under a carrier Automix already runs is as late as one whose carrier plays during the wait.
        if (attachment.intent === 'preroll' && !attachment.carrier.paused) {
            this.guard(() => this.cutIfPrerollLate(attachment));
        }
        if (attachment.intent !== 'idle') this.guard(() => this.mirror.drive());
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

    // The listener paused while Automix still held the arriving song's carrier: pause the early start and let the
    // listener's own play start Music later. Its autoplay is Automix's (suppressAutoplayRef), so it is left alone.
    private abortPreroll(): void {
        const attachment = this.attachment;
        if (!attachment || !this.isPrerolling(attachment)) return;
        if (attachment.started) attachment.sync?.abortStart();
        attachment.intent = 'idle';
        this.guard(() => this.mirror.yieldControl());
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
        // Music gets the user volume back once it stops playing this song (a following song's bind takes over first).
        this.guard(() => this.mirror.unbind());
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

    // Envelope, volume and carrier handlers run inside Automix, the pause fade and media events: a failure is logged
    // once and dropped, never thrown into them.
    private guard(action: () => void): void {
        try {
            action();
        } catch (error) {
            if (this.warned) return;
            this.warned = true;
            console.warn('[ExternalPlaybackSession] failed to follow Automix or the volume mirror', error);
        }
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
