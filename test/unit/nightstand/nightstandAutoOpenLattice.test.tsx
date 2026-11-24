// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { create } from 'zustand';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlayerState } from '@/types';
import type { AppView } from '@/stores/useAppViewStore';

// test/unit/nightstand/nightstandAutoOpenLattice.test.tsx
// NightstandHost's portrait auto-open into the queue collage: only the first play after a cold start
// (or after the queue emptied) pulls the listener in. Once there is a queue and they have been on the
// collage, a song change while they are elsewhere leaves them there - re-entering the collage on every
// change took the iPhone's web process past its memory limit (2026-11-21 device log).

type Song = { id: string };
type PlaybackState = { currentSong: Song | null; playQueue: Song[]; isFmMode: boolean; playerState: PlayerState };

const playback = create<PlaybackState>(() => ({ currentSong: null, playQueue: [], isFmMode: false, playerState: PlayerState.IDLE }));

vi.mock('@/components/nightstand/nightstandPlatform', () => ({ isNightstandSupported: () => true }));
vi.mock('@/components/nightstand/useIsLandscape', () => ({ useIsLandscape: () => false }));
vi.mock('@/components/nightstand/NightstandOverlay', () => ({ default: () => null }));
vi.mock('@/utils/keyboardTargets', () => ({
    hasBlockingWindow: () => false,
    hasOpenSheet: () => false,
    isTextEntryTarget: () => false,
}));
vi.mock('@/utils/appPlaybackGuards', () => ({ getPlaybackSongKey: (song: Song) => song.id }));
vi.mock('@/stores/usePlaybackStore', () => ({
    usePlaybackStore: playback,
    selectDisplayPlayerState: (state: PlaybackState) => state.playerState,
}));

const { default: NightstandHost } = await import('@/components/nightstand/NightstandHost');
const { usePlaybackEntryViewStore } = await import('@/stores/usePlaybackEntryViewStore');

const theme = { accentColor: '#fff' } as never;
let root: Root;
let container: HTMLDivElement;
const navigateToLattice = vi.fn();

const render = (view: AppView) => act(() => {
    root.render(
        <NightstandHost currentView={view} theme={theme} isDaylight={false}
            navigateToPlayer={vi.fn()} navigateToHome={vi.fn()} navigateToLattice={navigateToLattice} />,
    );
});

const play = (id: string, queue: Song[]) => act(() => {
    playback.setState({ currentSong: { id }, playQueue: queue, playerState: PlayerState.PLAYING });
});

const settle = () => act(() => { vi.advanceTimersByTime(1000); });

const QUEUE = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

describe('NightstandHost portrait auto-open into the queue collage', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        navigateToLattice.mockClear();
        playback.setState({ currentSong: null, playQueue: [], isFmMode: false, playerState: PlayerState.IDLE });
        usePlaybackEntryViewStore.setState({ playbackEntryView: 'stay', hasChosenPlaybackEntryView: true });
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
        vi.useRealTimers();
    });

    it('opens the collage for the first play after a cold start', () => {
        render('home');
        play('a', QUEUE);
        render('home');
        settle();
        expect(navigateToLattice).toHaveBeenCalledTimes(1);
    });

    it('does not pull the listener back after they left the collage, however the song changes', () => {
        render('home');
        play('a', QUEUE);
        render('home');
        settle();
        expect(navigateToLattice).toHaveBeenCalledTimes(1);

        // They are on the collage, then go back home and switch songs there (next track, auto-advance).
        render('lattice');
        render('home');
        play('b', QUEUE);
        render('home');
        settle();
        play('c', QUEUE);
        render('home');
        settle();
        expect(navigateToLattice).toHaveBeenCalledTimes(1);
    });

    it('arms again once the queue has emptied: the next first play opens the collage', () => {
        render('home');
        play('a', QUEUE);
        render('home');
        settle();
        render('lattice');
        render('home');

        act(() => { playback.setState({ currentSong: null, playQueue: [], playerState: PlayerState.IDLE }); });
        render('home');
        play('x', [{ id: 'x' }, { id: 'y' }]);
        render('home');
        settle();
        expect(navigateToLattice).toHaveBeenCalledTimes(2);
    });
});
