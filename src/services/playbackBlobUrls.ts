import { isUrlOnAudioElement } from '../utils/mediaElementSources';
import { carrierRegistry } from './externalPlayback/carrierRegistry';

// src/services/playbackBlobUrls.ts

/** Blob URLs handed over but not yet safe to revoke - see `retireBlobUrl`. */
let heldBlobUrls: string[] = [];

/**
 * Hands a track's blob URL over for revoking, and revokes only the ones no deck is using.
 *
 * Revoking as the app commits to the next song is wrong during a blend: the previous track keeps
 * sounding on the other deck for the whole transition. It plays on - which is why this went unnoticed
 * for the feature's whole life - because continuing only needs what the element already has resident.
 * The damage shows the first time anything SEEKS that deck: the seek never completes, readyState
 * collapses from 4 (HAVE_ENOUGH_DATA) to 1 (HAVE_METADATA), and the element sits there with
 * `paused === false` and no `error` event at all. Silent, permanent, and invisible to every watchdog
 * in the app, which is how it reached a listener as "I dragged the bar and the music just stopped".
 *
 * Measured rather than reasoned: after a revoke, a short seek backwards inside the resident buffer
 * still fires `seeked` and keeps readyState 4, while a forward seek times out with no `seeked` and
 * never recovers - which is also why the same drag survived sometimes and killed playback others.
 *
 * The rule is asked, not assumed. Holding a fixed number of generations back is the obvious version
 * and it is wrong: it assumes every song change steps FORWARD, and cancelling a blend by seeking
 * steps back - the app returns to the outgoing track while `blobUrlRef` still names the one it
 * abandoned, so one arm later the ledger retires the wrong URL and revokes the one the active deck
 * is playing. Reading the decks instead means no caller has to keep this straight: a URL survives
 * exactly as long as an element is sounding it, whichever way the app got there. Nothing leaks - the
 * next handover sweeps whatever has since been let go - and the list cannot outgrow the two decks
 * plus the track being handed over.
 *
 * A shared silent carrier is not kept here: the carrier registry counts everyone holding it (this caller,
 * Automix's preroll) and applies the same deck check itself, so the hand-over only gives this caller's
 * reference back.
 */
export const retireBlobUrl = (nextBlobUrl: string | null) => {
    const handedOver = nextBlobUrl && !carrierRegistry.releaseUrl(nextBlobUrl) ? nextBlobUrl : null;
    heldBlobUrls = heldBlobUrls.filter(url => {
        if (url === handedOver || isUrlOnAudioElement(url)) return true;
        URL.revokeObjectURL(url);
        return false;
    });
    if (handedOver && !heldBlobUrls.includes(handedOver)) {
        heldBlobUrls.push(handedOver);
    }
};

/** Drops a blob URL nobody is using yet: a shared carrier gives one reference back, anything else is revoked. */
export const releasePlaybackBlobUrl = (url: string) => {
    if (!carrierRegistry.releaseUrl(url)) URL.revokeObjectURL(url);
};
