import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/electron/appleMusicBridge.test.ts — main-process JXA bridge: framing, ids, validation, timeouts, restart and polling.

const require = createRequire(import.meta.url);
const { createMusicAppBridge } = require('../../../electron/appleMusic/musicAppBridge.cjs');
const { MUSIC_APP_JXA_SOURCE } = require('../../../electron/appleMusic/musicAppScript.cjs');

type JxaMessage = { id: number; op: string; args: Record<string, unknown> };
type JxaReply = { ok: true; data: unknown } | { ok: false; error: { number: number | null; message: string } };
type Respond = (message: JxaMessage) => JxaReply | undefined;

const ok = (data: unknown): JxaReply => ({ ok: true, data });
const scriptError = (number: number | null, message = 'script error'): JxaReply => ({ ok: false, error: { number, message } });

// A stand-in for the osascript child: the stdin spy records JSON lines and may answer them synchronously.
function createFakeChild(respond: Respond) {
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = vi.fn();
    child.kill = vi.fn();
    child.stdin.write = vi.fn((line: string) => {
        const message = JSON.parse(line) as JxaMessage;
        const reply = respond(message);
        if (reply) child.stdout.emit('data', Buffer.from(JSON.stringify({ id: message.id, ...reply }) + '\n'));
        return true;
    });
    return child;
}

function writtenMessages(child: any): JxaMessage[] {
    return child.stdin.write.mock.calls.map((call: unknown[]) => JSON.parse(String(call[0])));
}
const writtenOps = (child: any) => writtenMessages(child).map(message => message.op);
const emitReply = (child: any, id: number, data: unknown) => child.stdout.emit('data', Buffer.from(JSON.stringify({ id, ok: true, data }) + '\n'));

function setup(options: { platform?: string; respond?: Respond } = {}) {
    const children: any[] = [];
    let respond: Respond = options.respond ?? (() => undefined);
    const spawn = vi.fn((_command: string, _args: string[]) => {
        const child = createFakeChild(message => respond(message));
        children.push(child);
        return child;
    });
    const onState = vi.fn();
    const stored = new Map<string, string>();
    const artwork = { has: vi.fn(async (_assetId: string) => false), write: vi.fn(async (_assetId: string, _bytes: Buffer, _mime: string) => undefined) };
    const artworkIndex = {
        get: vi.fn((trackId: string) => stored.get(trackId)),
        set: vi.fn((trackId: string, assetId: string) => { stored.set(trackId, assetId); }),
    };
    const bridge = createMusicAppBridge({ spawn, platform: options.platform ?? 'darwin', onState, artwork, artworkIndex });
    return { bridge, spawn, children, onState, artwork, artworkIndex, setRespond: (next: Respond) => { respond = next; } };
}

const PERSISTENT_ID = 'ABCDEF0123456789';
const getStateReply = ok({ state: 'playing', persistentId: PERSISTENT_ID, position: 3, duration: 200 });

describe('Apple Music app bridge', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

    it('embeds the validated JXA program that answers one JSON line per request', () => {
        expect(MUSIC_APP_JXA_SOURCE).toContain("ObjC.import('Foundation');");
        expect(MUSIC_APP_JXA_SOURCE).toContain('function run()');
        expect(MUSIC_APP_JXA_SOURCE).toContain("Number(chunk.length) === 0");
    });

    it('spawns osascript in JavaScript mode once and reuses the process', async () => {
        const { bridge, spawn, children } = setup({ respond: () => ok({ running: true, permission: 'unknown' }) });
        await bridge.request('probe', {});
        await bridge.request('probe', {});
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(spawn).toHaveBeenCalledWith('osascript', ['-l', 'JavaScript', '-e', MUSIC_APP_JXA_SOURCE]);
        expect(children[0].stdin.write).toHaveBeenCalledTimes(2);
    });

    it('matches responses to requests by id even when they arrive out of order', async () => {
        const { bridge, children } = setup();
        const first = bridge.request('getTrack', { id: PERSISTENT_ID });
        const second = bridge.request('probe', {});
        const [one, two] = writtenMessages(children[0]);
        expect(one.id).not.toBe(two.id);
        emitReply(children[0], two.id, { running: true, permission: 'unknown' });
        emitReply(children[0], one.id, { id: PERSISTENT_ID, name: 'N', artist: 'A', albumArtist: 'AA', album: 'Al', duration: 1.5, mediaKind: 'song' });
        expect(await second).toEqual({ ok: true, data: { running: true, permission: 'unknown' } });
        expect(await first).toMatchObject({ ok: true, data: { id: PERSISTENT_ID, name: 'N' } });
    });

    it('splits stdout into lines across chunks and ignores unparsable lines', async () => {
        const { bridge, children } = setup();
        const request = bridge.request('probe', {});
        const [message] = writtenMessages(children[0]);
        const line = JSON.stringify({ id: message.id, ok: true, data: { running: false, permission: 'unknown' } }) + '\n';
        children[0].stdout.emit('data', Buffer.from('not json at all\n{"id":'));
        children[0].stdout.emit('data', Buffer.from(line.slice(6, 20)));
        children[0].stdout.emit('data', Buffer.from(line.slice(20)));
        expect(await request).toEqual({ ok: true, data: { running: false, permission: 'unknown' } });
    });

    it('rejects malformed ids and arguments without writing to the process', async () => {
        const { bridge, spawn } = setup({ respond: () => ok(null) });
        expect(await bridge.request('getTrack', { id: '../etc' })).toMatchObject({ ok: false, error: { code: 'invalid-response' } });
        expect(await bridge.request('getArtwork', { id: 'ABCDEF012345678' })).toMatchObject({ ok: false, error: { code: 'invalid-response' } });
        expect(await bridge.request('getPlaylistTracks', { playlistId: 'nope' })).toMatchObject({ ok: false, error: { code: 'invalid-response' } });
        expect(await bridge.request('searchLibrary', { query: '', limit: 10 })).toMatchObject({ ok: false });
        expect(await bridge.request('searchLibrary', { query: 'x'.repeat(201), limit: 10 })).toMatchObject({ ok: false });
        expect(await bridge.request('searchLibrary', { query: 'x', limit: 0 })).toMatchObject({ ok: false });
        expect(await bridge.request('searchLibrary', { query: 'x', limit: 101 })).toMatchObject({ ok: false });
        expect(await bridge.request('searchLibrary', { query: 'x', limit: 1.5 })).toMatchObject({ ok: false });
        expect(await bridge.request('seek', { position: -1 })).toMatchObject({ ok: false });
        expect(await bridge.request('seek', { position: Number.NaN })).toMatchObject({ ok: false });
        expect(await bridge.request('play', { id: PERSISTENT_ID, position: Infinity })).toMatchObject({ ok: false });
        expect(await bridge.request('setVolume', { volume: 1.2 })).toMatchObject({ ok: false });
        expect(await bridge.request('setVolume', { volume: '0.5' })).toMatchObject({ ok: false });
        expect(await bridge.request('probe', [])).toMatchObject({ ok: false, error: { code: 'invalid-response' } });
        expect(await bridge.request('eval', {})).toMatchObject({ ok: false, error: { code: 'unsupported' } });
        expect(await bridge.request('constructor', {})).toMatchObject({ ok: false, error: { code: 'unsupported' } });
        expect(spawn).not.toHaveBeenCalled();
    });

    it('accepts the library playlist id and case-insensitive persistent ids', async () => {
        const { bridge, children } = setup({ respond: () => ok([]) });
        expect(await bridge.request('getPlaylistTracks', { playlistId: 'library' })).toEqual({ ok: true, data: [] });
        expect(await bridge.request('getPlaylistTracks', { playlistId: 'abcdef0123456789' })).toEqual({ ok: true, data: [] });
        expect(writtenMessages(children[0]).map(message => message.args)).toEqual([{ playlistId: 'library' }, { playlistId: 'abcdef0123456789' }]);
    });

    it('passes the search query as JSON data, never as script text', async () => {
        const { bridge, children } = setup({ respond: () => ok([]) });
        const query = '"); do shell script("x';
        await bridge.request('searchLibrary', { query, limit: 10, extra: 'dropped' });
        const [line] = children[0].stdin.write.mock.calls[0] as [string];
        expect(line.endsWith('\n')).toBe(true);
        expect(line.indexOf('\n')).toBe(line.length - 1);
        expect(JSON.parse(line)).toMatchObject({ op: 'searchLibrary', args: { query, limit: 10 } });
        expect(JSON.parse(line).args).not.toHaveProperty('extra');
    });

    it('maps AppleScript error numbers to provider error codes', async () => {
        const { bridge, setRespond } = setup();
        const cases: Array<[number | null, string]> = [[-1743, 'auth-required'], [-600, 'unavailable'], [-609, 'unavailable'], [-1728, 'not-playable'], [null, 'unavailable']];
        for (const [number, code] of cases) {
            setRespond(() => scriptError(number, 'boom'));
            expect(await bridge.request('getTrack', { id: PERSISTENT_ID })).toEqual({ ok: false, error: { code, message: 'boom' } });
        }
    });

    it('times out control operations after 8 s', async () => {
        const { bridge, children } = setup();
        const result = bridge.request('pause', {});
        let settled = false;
        void result.then(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(7999);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(await result).toMatchObject({ ok: false, error: { code: 'network' } });
        // A reply that arrives after the timeout is ignored.
        emitReply(children[0], writtenMessages(children[0])[0].id, null);
    });

    it('uses the list timeout for list operations', async () => {
        const { bridge } = setup();
        const result = bridge.request('getPlaylistTracks', { playlistId: 'library' });
        let settled = false;
        void result.then(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(8000);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(21999);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(await result).toMatchObject({ ok: false, error: { code: 'network' } });
    });

    it('fails in-flight requests with network when the process exits and restarts with backoff', async () => {
        const { bridge, spawn, children, setRespond } = setup();
        setRespond(message => (message.op === 'getState' ? getStateReply : undefined));

        // First exit: the request is re-sent once, on the restarted process, and takes that process's reply.
        const retried = bridge.request('pause', {});
        const [original] = writtenMessages(children[0]);
        children[0].emit('exit', 1, null);
        expect(spawn).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(499);
        expect(spawn).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(spawn).toHaveBeenCalledTimes(2);
        expect(writtenMessages(children[1])).toEqual([original]);
        emitReply(children[1], original.id, null);
        expect(await retried).toEqual({ ok: true, data: null });

        // A request that was already answered is not sent again, and a second exit before the answer fails the retry.
        const doomed = bridge.request('resume', {});
        children[1].emit('exit', 1, null);
        await vi.advanceTimersByTimeAsync(500);
        expect(spawn).toHaveBeenCalledTimes(3);
        expect(writtenOps(children[2])).toEqual(['resume']);
        children[2].emit('exit', 1, null);
        expect(await doomed).toMatchObject({ ok: false, error: { code: 'network' } });
    });

    it('keeps the original timeout on a request that waits for the restart', async () => {
        const { bridge, spawn, children } = setup();
        const inFlight = bridge.request('pause', {});
        children[0].emit('exit', 1, null);
        await vi.advanceTimersByTimeAsync(500);
        expect(spawn).toHaveBeenCalledTimes(2);
        // Re-sent at 500 ms but still due 8 s after the original call.
        await vi.advanceTimersByTimeAsync(7499);
        let settled = false;
        void inFlight.then(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(await inFlight).toMatchObject({ ok: false, error: { code: 'network' } });
    });

    it('backs off 500, 2000 and 10000 ms while the process keeps dying and resets after a reply', async () => {
        const { bridge, spawn, children, setRespond } = setup();
        // Each delay is measured from the previous exit: ask 100 ms before it is over, expect the spawn exactly then.
        const spawnAfter = async (delayMs: number, spawns: number) => {
            await vi.advanceTimersByTimeAsync(delayMs - 100);
            const pending = bridge.request('pause', {});
            await vi.advanceTimersByTimeAsync(99);
            expect(spawn).toHaveBeenCalledTimes(spawns - 1);
            await vi.advanceTimersByTimeAsync(1);
            expect(spawn).toHaveBeenCalledTimes(spawns);
            return { pending };
        };
        const first = bridge.request('pause', {});
        children[0].emit('exit', 1, null);
        await vi.advanceTimersByTimeAsync(499);
        expect(spawn).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(spawn).toHaveBeenCalledTimes(2);
        children[1].emit('exit', 1, null);
        expect(await first).toMatchObject({ ok: false, error: { code: 'network' } });

        const { pending: second } = await spawnAfter(2000, 3);
        children[2].emit('exit', 1, null);
        // The retry would have to wait 10 s for the restart, longer than the 8 s timeout.
        const { pending: third } = await spawnAfter(10000, 4);
        expect(await second).toMatchObject({ ok: false, error: { code: 'network' } });
        children[3].emit('exit', 1, null);

        setRespond(() => ok(null));
        const { pending: fourth } = await spawnAfter(10000, 5);
        expect(await third).toMatchObject({ ok: false, error: { code: 'network' } });
        expect(await fourth).toEqual({ ok: true, data: null });

        // A reply proves the process worked, so the next crash starts again from 500 ms.
        children[4].emit('exit', 1, null);
        expect(await (await spawnAfter(500, 6)).pending).toEqual({ ok: true, data: null });
    });

    it('treats a failed spawn as an exit', async () => {
        const { bridge, spawn, children } = setup();
        const pending = bridge.request('pause', {});
        children[0].emit('error', new Error('spawn osascript ENOENT'));
        await vi.advanceTimersByTimeAsync(500);
        expect(spawn).toHaveBeenCalledTimes(2);
        children[1].emit('error', new Error('spawn osascript ENOENT'));
        expect(await pending).toMatchObject({ ok: false, error: { code: 'network' } });
    });

    it('samples the position at the midpoint of when the script started the request and the reply', async () => {
        vi.setSystemTime(1_000_000);
        const { bridge, children } = setup();
        // A slow list call occupies the single-threaded script; the state read queued behind it only starts once it is done.
        const slow = bridge.request('searchLibrary', { query: 'x', limit: 10 });
        await vi.advanceTimersByTimeAsync(100);
        const state = bridge.request('getState', {});
        const [slowMessage, stateMessage] = writtenMessages(children[0]);
        await vi.advanceTimersByTimeAsync(1400);
        emitReply(children[0], slowMessage.id, []);
        await vi.advanceTimersByTimeAsync(30);
        emitReply(children[0], stateMessage.id, { state: 'playing', persistentId: PERSISTENT_ID, position: 7, duration: 100 });
        expect(await slow).toEqual({ ok: true, data: [] });
        expect(await state).toMatchObject({ ok: true, data: { sampledAtMs: 1_000_000 + 1500 + 15 } });
    });

    it('counts a reply to an already timed-out request as the moment the next one started', async () => {
        vi.setSystemTime(1_000_000);
        const { bridge, children } = setup();
        const timedOut = bridge.request('pause', {});
        await vi.advanceTimersByTimeAsync(100);
        const state = bridge.request('getState', {});
        const [pauseMessage, stateMessage] = writtenMessages(children[0]);
        // pause times out at 8000 ms, getState would at 8100 ms; the late reply to pause still ends the script's busy time.
        await vi.advanceTimersByTimeAsync(7950);
        expect(await timedOut).toMatchObject({ ok: false, error: { code: 'network' } });
        emitReply(children[0], pauseMessage.id, null);
        await vi.advanceTimersByTimeAsync(30);
        emitReply(children[0], stateMessage.id, { state: 'paused', persistentId: null, position: 0, duration: null });
        expect(await state).toMatchObject({ ok: true, data: { sampledAtMs: 1_000_000 + 8050 + 15 } });
    });

    it('polls getState only while monitoring and pushes normalized state', async () => {
        vi.setSystemTime(1_000_000);
        const { bridge, children, onState } = setup();
        bridge.setMonitoring(true);
        await vi.advanceTimersByTimeAsync(999);
        expect(children).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(1);
        const [poll] = writtenMessages(children[0]);
        expect(poll.op).toBe('getState');
        await vi.advanceTimersByTimeAsync(100);
        emitReply(children[0], poll.id, { state: 'fast forwarding', persistentId: PERSISTENT_ID, position: 12.5, duration: 200 });
        await vi.advanceTimersByTimeAsync(0);
        expect(onState).toHaveBeenCalledWith({ state: 'playing', mediaId: PERSISTENT_ID, positionSec: 12.5, durationSec: 200, sampledAtMs: 1_000_000 + 1000 + 50 });

        await vi.advanceTimersByTimeAsync(1000);
        expect(writtenOps(children[0])).toEqual(['getState', 'getState']);
        const pollTwo = writtenMessages(children[0])[1];
        // While a poll is unanswered the next tick does not pile another one on the single-threaded script.
        await vi.advanceTimersByTimeAsync(1000);
        expect(writtenOps(children[0])).toEqual(['getState', 'getState']);
        bridge.setMonitoring(false);
        emitReply(children[0], pollTwo.id, { state: 'paused', persistentId: null, position: 0, duration: null });
        await vi.advanceTimersByTimeAsync(0);
        expect(onState).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(5000);
        expect(writtenOps(children[0])).toEqual(['getState', 'getState']);
    });

    it('normalizes every Music player state', async () => {
        const { bridge, setRespond } = setup();
        const cases: Array<[string, string]> = [['playing', 'playing'], ['fast forwarding', 'playing'], ['rewinding', 'playing'], ['paused', 'paused'], ['stopped', 'stopped'], ['weird', 'stopped']];
        for (const [raw, expected] of cases) {
            setRespond(() => ok({ state: raw, persistentId: null, position: 0, duration: null }));
            const result = await bridge.request('getState', {});
            expect(result).toMatchObject({ ok: true, data: { state: expected, mediaId: null, positionSec: 0, durationSec: null } });
        }
    });

    it('refreshes state right after a successful control command', async () => {
        const { bridge, children, onState, setRespond } = setup();
        setRespond(message => (message.op === 'getState' ? getStateReply : ok(null)));
        await bridge.request('seek', { position: 42 });
        expect(writtenOps(children[0])).toEqual(['seek', 'getState']);
        await vi.advanceTimersByTimeAsync(0);
        expect(onState).toHaveBeenCalledTimes(1);
        await bridge.request('pause', {});
        await bridge.request('resume', {});
        expect(writtenOps(children[0])).toEqual(['seek', 'getState', 'pause', 'getState', 'resume', 'getState']);
        // A failed command does not trigger a refresh.
        setRespond(() => scriptError(-600));
        await bridge.request('pause', {});
        expect(writtenOps(children[0]).slice(-1)).toEqual(['pause']);
    });

    it('converts volume to the 0-100 scale', async () => {
        const { bridge, children } = setup({ respond: () => ok(null) });
        await bridge.request('setVolume', { volume: 0.426 });
        await bridge.request('setVolume', { volume: 0 });
        await bridge.request('setVolume', { volume: 1 });
        expect(writtenMessages(children[0]).map(message => message.args.volume)).toEqual([43, 0, 100]);
    });

    it('stops Music on quit only when Folia started the playback', async () => {
        const { bridge, spawn, children, setRespond } = setup();
        await bridge.stopIfOwned();
        expect(spawn).not.toHaveBeenCalled();

        setRespond(message => (message.op === 'getState' ? getStateReply : ok(null)));
        await bridge.request('play', { id: PERSISTENT_ID, position: 0 });
        await bridge.stopIfOwned();
        expect(writtenOps(children[0]).filter(op => op === 'stop')).toHaveLength(1);
        await bridge.stopIfOwned();
        expect(writtenOps(children[0]).filter(op => op === 'stop')).toHaveLength(1);
    });

    it('keeps ownership when the stop did not succeed, and an explicit stop releases it', async () => {
        const { bridge, children, setRespond } = setup();
        setRespond(message => (message.op === 'getState' ? getStateReply : ok(null)));
        await bridge.request('play', { id: PERSISTENT_ID, position: 0 });
        setRespond(message => (message.op === 'stop' ? scriptError(-600) : ok(null)));
        await bridge.stopIfOwned();
        await bridge.stopIfOwned();
        expect(writtenOps(children[0]).filter(op => op === 'stop')).toHaveLength(2);

        setRespond(() => ok(null));
        await bridge.request('stop', {});
        await bridge.stopIfOwned();
        expect(writtenOps(children[0]).filter(op => op === 'stop')).toHaveLength(3);
    });

    it('returns tracks without mediaKind and with the indexed artwork asset', async () => {
        const { bridge, artworkIndex, setRespond } = setup();
        const raw = { id: PERSISTENT_ID, name: 'Song', artist: 'Artist', albumArtist: 'Album Artist', album: 'Album', duration: 215.4, mediaKind: 'song' };
        setRespond(() => ok([raw]));
        const list = await bridge.request('searchLibrary', { query: 'song', limit: 5 });
        expect(list).toEqual({ ok: true, data: [{ id: PERSISTENT_ID, name: 'Song', artist: 'Artist', albumArtist: 'Album Artist', album: 'Album', duration: 215.4 }] });
        artworkIndex.set(PERSISTENT_ID, 'sha256:abc');
        const tracks = await bridge.request('getPlaylistTracks', { playlistId: 'library' });
        expect(tracks).toMatchObject({ ok: true, data: [{ id: PERSISTENT_ID, artworkAssetId: 'sha256:abc' }] });
        expect(JSON.stringify(tracks)).not.toContain('mediaKind');
    });

    it('lists playlists', async () => {
        const { bridge, setRespond } = setup();
        setRespond(() => ok([{ id: 'library', name: '', kind: 'library' }, { id: 'FEDCBA9876543210', name: 'Mix', kind: 'user' }]));
        expect(await bridge.request('listPlaylists', {})).toEqual({ ok: true, data: [{ id: 'library', name: '', kind: 'library' }, { id: 'FEDCBA9876543210', name: 'Mix', kind: 'user' }] });
    });

    it('stores artwork bytes as a content-addressed cover and indexes it', async () => {
        const { bridge, artwork, artworkIndex, setRespond } = setup();
        const bytes = Buffer.from('FFD8FFE000104A4649460001010000010001000000', 'hex');
        const assetId = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
        setRespond(() => ok({ hex: bytes.toString('hex').toUpperCase() }));

        expect(await bridge.request('getArtwork', { id: PERSISTENT_ID })).toEqual({ ok: true, data: { assetId } });
        expect(artwork.write).toHaveBeenCalledTimes(1);
        expect(artwork.write).toHaveBeenCalledWith(assetId, bytes, 'image/jpeg');
        expect(artworkIndex.set).toHaveBeenCalledWith(PERSISTENT_ID, assetId);

        // Already stored: indexed again, but not written twice.
        artwork.has.mockResolvedValue(true);
        expect(await bridge.request('getArtwork', { id: PERSISTENT_ID })).toEqual({ ok: true, data: { assetId } });
        expect(artwork.write).toHaveBeenCalledTimes(1);

        setRespond(() => ok({ id: PERSISTENT_ID, name: 'N', artist: 'A', albumArtist: 'AA', album: 'Al', duration: 1, mediaKind: 'song' }));
        expect(await bridge.request('getTrack', { id: PERSISTENT_ID })).toMatchObject({ ok: true, data: { id: PERSISTENT_ID, artworkAssetId: assetId } });
    });

    it('recognises PNG covers and drops unknown or missing artwork without writing', async () => {
        const { bridge, artwork, artworkIndex, setRespond } = setup();
        const png = Buffer.from('89504E470D0A1A0A', 'hex');
        setRespond(() => ok({ hex: png.toString('hex') }));
        expect(await bridge.request('getArtwork', { id: PERSISTENT_ID })).toMatchObject({ ok: true, data: { assetId: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) } });
        expect(artwork.write).toHaveBeenCalledWith(expect.any(String), png, 'image/png');

        artwork.write.mockClear();
        artworkIndex.set.mockClear();
        for (const reply of [ok({ hex: '00112233' }), ok({ hex: 'FFD8F' }), ok({ hex: 'zz' }), ok({ hex: '' }), ok(null)]) {
            setRespond(() => reply);
            expect(await bridge.request('getArtwork', { id: PERSISTENT_ID })).toEqual({ ok: true, data: null });
        }
        expect(artwork.write).not.toHaveBeenCalled();
        expect(artworkIndex.set).not.toHaveBeenCalled();
    });

    it('polls every 250 ms for 8 s after play, then every second', async () => {
        const { bridge, children, setRespond } = setup();
        setRespond(message => (message.op === 'getState' ? getStateReply : ok(null)));
        bridge.setMonitoring(true);
        const stateWrites = () => writtenOps(children[0]).filter(op => op === 'getState').length;

        await bridge.request('play', { id: PERSISTENT_ID, position: 0 });
        // play itself refreshes immediately
        expect(stateWrites()).toBe(1);
        await vi.advanceTimersByTimeAsync(249);
        expect(stateWrites()).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(stateWrites()).toBe(2);
        await vi.advanceTimersByTimeAsync(7750);
        // 32 polls at 250 ms intervals inside the 8 s window, plus the refresh
        expect(stateWrites()).toBe(1 + 32);
        await vi.advanceTimersByTimeAsync(999);
        expect(stateWrites()).toBe(1 + 32);
        await vi.advanceTimersByTimeAsync(1);
        expect(stateWrites()).toBe(1 + 33);
        await vi.advanceTimersByTimeAsync(1000);
        expect(stateWrites()).toBe(1 + 34);
    });

    it('is unavailable and never spawns on other platforms', async () => {
        const { bridge, spawn } = setup({ platform: 'linux' });
        expect(bridge.isAvailable()).toBe(false);
        expect(await bridge.request('probe', {})).toMatchObject({ ok: false, error: { code: 'unavailable' } });
        bridge.setMonitoring(true);
        await vi.advanceTimersByTimeAsync(5000);
        await bridge.stopIfOwned();
        expect(spawn).not.toHaveBeenCalled();
        expect(setup().bridge.isAvailable()).toBe(true);
    });

    it('does not crash on a broken stdin pipe', async () => {
        const { bridge, children } = setup();
        const pending = bridge.request('pause', {});
        expect(() => children[0].stdin.emit('error', new Error('write EPIPE'))).not.toThrow();
        children[0].emit('exit', 1, null);
        await vi.advanceTimersByTimeAsync(500);
        children[1].emit('exit', 1, null);
        expect(await pending).toMatchObject({ ok: false, error: { code: 'network' } });
    });

    it('prints only the first 200 characters of stderr', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const { bridge, children } = setup();
        void bridge.request('pause', {});
        children[0].stderr.emit('data', Buffer.from('x'.repeat(500)));
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][warn.mock.calls[0].length - 1])).toHaveLength(200);
    });

    it('resolves pending requests, stops polling and kills the process on dispose', async () => {
        const { bridge, spawn, children } = setup();
        bridge.setMonitoring(true);
        const pending = bridge.request('pause', {});
        bridge.dispose();
        expect(await pending).toMatchObject({ ok: false });
        expect(children[0].kill).toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(5000);
        expect(await bridge.request('pause', {})).toMatchObject({ ok: false, error: { code: 'unavailable' } });
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(writtenOps(children[0])).toEqual(['pause']);
    });
});
