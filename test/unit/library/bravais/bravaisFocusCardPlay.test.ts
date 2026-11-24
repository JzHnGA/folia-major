import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import BravaisFocusCardBody, { type BravaisFocusCardActions } from '../../../../src/library/suites/bravais/BravaisFocusCardBody';
import type { BravaisItem } from '../../../../src/library/suites/bravais/bravaisLayer';

// test/unit/library/bravais/bravaisFocusCardPlay.test.ts
// The play button of a song's focus card. A song that cannot be played keeps it enabled (only
// dimmed), so a tap reaches playback, which says why and offers another version: a disabled
// button that still looked lit did nothing at all when tapped.

const noop = () => undefined;
const actions: BravaisFocusCardActions = {
    play: noop,
    enqueue: noop,
    canCollect: () => false,
    collect: noop,
    canSaveToPlaylist: () => false,
    saveToPlaylist: noop,
    canOpenAlbum: () => false,
    openAlbum: noop,
    canOpenArtist: () => false,
    openArtist: noop,
    menuFor: () => [],
    runMenu: noop,
    hover: noop,
    togglesCurrent: true,
};

const song = (over: Partial<BravaisItem> = {}): BravaisItem => ({
    key: 'entry:1',
    kind: 'track',
    title: 'Have a nice day',
    subtitle: 'imase',
    badge: '0001',
    ...over,
});

const playButton = (item: BravaisItem, current = false) => {
    const markup = renderToStaticMarkup(React.createElement(BravaisFocusCardBody, {
        slotKey: '0:0:0', item, queued: false, current, titleWidth: 300, actions,
    }));
    const match = /<button[^>]*data-bravais-action="play"[^>]*>/.exec(markup);
    expect(match).not.toBeNull();
    return match![0];
};

describe('focus card play button', () => {
    it('stays enabled, marked unavailable, for a song that cannot be played', () => {
        const button = playButton(song({ unavailable: true }));
        expect(button).not.toContain('disabled');
        expect(button).toContain('data-bravais-unavailable="true"');
    });

    it('is not marked for a song that can be played', () => {
        expect(playButton(song())).not.toContain('data-bravais-unavailable');
    });

    it('is not marked on the playing song, where it pauses and resumes', () => {
        expect(playButton(song({ unavailable: true }), true)).not.toContain('data-bravais-unavailable');
    });
});
