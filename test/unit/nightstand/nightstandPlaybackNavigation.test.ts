import { describe, expect, it } from 'vitest';
import { PlayerState } from '@/types';
import {
    resolveNightstandRotationTarget,
    shouldAutoOpenNightstandLattice,
    type NightstandNavigationTarget,
} from '@/components/nightstand/nightstandPlaybackNavigation';

// test/unit/nightstand/nightstandPlaybackNavigation.test.ts
// 竖屏播放自动进队列拼贴、横竖屏翻转后去哪：决定「动不动、去哪儿」的纯规则。
// 真要紧的是几个边界：恢复出来的暂停会话不拉人、同一首歌进过一次就不再拉、空队列 / FM / 阻塞界面。

type RotationOverrides = Partial<Parameters<typeof resolveNightstandRotationTarget>[0]>;

const rotation = (overrides: RotationOverrides = {}): NightstandNavigationTarget | null => resolveNightstandRotationTarget({
    isLandscape: false,
    firstObservation: false,
    currentView: 'home',
    currentSongKey: 'song-a',
    hasQueue: true,
    playerState: PlayerState.PLAYING,
    entryView: 'stay',
    isFmMode: false,
    ...overrides,
});

describe('resolveNightstandRotationTarget', () => {
    it('横屏一律去播放页，包括启动后的第一次观察', () => {
        expect(rotation({ isLandscape: true })).toBe('player');
        expect(rotation({ isLandscape: true, firstObservation: true })).toBe('player');
    });

    it('竖屏第一次观察不动：启动本来就落在首页', () => {
        expect(rotation({ firstObservation: true })).toBeNull();
    });

    it('竖屏有歌在播、留在原处、队列非空：去队列拼贴', () => {
        expect(rotation()).toBe('lattice');
        expect(rotation({ entryView: 'lattice' })).toBe('lattice');
    });

    it('暂停、空队列、FM、显式选了播放页：回首页', () => {
        expect(rotation({ playerState: PlayerState.PAUSED })).toBe('home');
        expect(rotation({ hasQueue: false })).toBe('home');
        expect(rotation({ isFmMode: true })).toBe('home');
        expect(rotation({ entryView: 'player' })).toBe('home');
        expect(rotation({ currentSongKey: null })).toBe('home');
    });

    it('已经停在拼贴上：竖屏留在原处，不把拼贴拉回首页', () => {
        expect(rotation({ currentView: 'lattice' })).toBeNull();
        expect(rotation({ currentView: 'lattice', playerState: PlayerState.PAUSED })).toBeNull();
    });
});

type AutoOverrides = Partial<Parameters<typeof shouldAutoOpenNightstandLattice>[0]>;

const auto = (overrides: AutoOverrides = {}): boolean => shouldAutoOpenNightstandLattice({
    supported: true,
    isLandscape: false,
    isFmMode: false,
    entryView: 'stay',
    currentView: 'home',
    currentSongKey: 'song-a',
    hasQueue: true,
    playerState: PlayerState.PLAYING,
    handledSongKey: null,
    ...overrides,
});

describe('shouldAutoOpenNightstandLattice', () => {
    it('竖屏停在首页、真的在播放、队列非空：自动进拼贴', () => {
        expect(auto()).toBe(true);
    });

    it('恢复出来的暂停会话、暂停状态都不拉人', () => {
        expect(auto({ playerState: PlayerState.PAUSED })).toBe(false);
        expect(auto({ playerState: PlayerState.IDLE })).toBe(false);
    });

    it('同一首歌进过一次就不再拉，换歌后重新允许', () => {
        expect(auto({ handledSongKey: 'song-a' })).toBe(false);
        expect(auto({ handledSongKey: 'song-b' })).toBe(true);
    });

    it('横屏、FM、非原生壳、非 stay、不在首页都不自动进', () => {
        expect(auto({ isLandscape: true })).toBe(false);
        expect(auto({ isFmMode: true })).toBe(false);
        expect(auto({ supported: false })).toBe(false);
        expect(auto({ entryView: 'lattice' })).toBe(false);
        expect(auto({ entryView: 'player' })).toBe(false);
        expect(auto({ currentView: 'lattice' })).toBe(false);
        expect(auto({ currentView: 'player' })).toBe(false);
    });

    it('退膛后（已经进过拼贴、队列还在）在首页换歌不再拉回拼贴', () => {
        expect(auto({ autoOpenArmed: false })).toBe(false);
        // 换了一首新歌也一样：只记“上一首”时，这里会把人拉回拼贴。
        expect(auto({ autoOpenArmed: false, currentSongKey: 'song-b', handledSongKey: 'song-a' })).toBe(false);
        // 冷启动 / 队列清空后重新上膛：第一次播放照旧进拼贴。
        expect(auto({ autoOpenArmed: true, currentSongKey: 'song-b', handledSongKey: 'song-a' })).toBe(true);
    });

    it('没有歌、或队列被清空：不进空拼贴', () => {
        expect(auto({ currentSongKey: null })).toBe(false);
        expect(auto({ hasQueue: false })).toBe(false);
    });
});
