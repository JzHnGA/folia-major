import type { PlaybackEntryView } from '../../stores/usePlaybackEntryViewStore';
import type { AppView } from '../../stores/useAppViewStore';
import { PlayerState } from '../../types';

// src/components/nightstand/nightstandPlaybackNavigation.ts
// Nightstand 竖屏播放的两个纯规则：播放一首歌时要不要自动进队列拼贴，方向翻转后要去哪。
// NightstandHost 只负责读 store、定时和导航；分支判断放在这里，单测直接喂状态。

export type NightstandNavigationTarget = 'player' | 'lattice' | 'home';

type RotationInput = {
    isLandscape: boolean;
    /** 启动后第一次看到方向（没有“从哪个方向翻过来”可谈）。 */
    firstObservation: boolean;
    currentView: AppView;
    currentSongKey: string | null;
    /** 播放队列里有歌：空队列的拼贴没有东西可看。 */
    hasQueue: boolean;
    playerState: PlayerState;
    entryView: PlaybackEntryView;
    isFmMode: boolean;
};

/**
 * 翻转后要去哪；null 是不动。
 * 横屏一律回播放页；竖屏有正在播放的歌（且留在原处）时去队列拼贴，其余回首页；
 * 已经停在拼贴上时留在原处，不把拼贴拉回首页。
 */
export const resolveNightstandRotationTarget = ({
    isLandscape,
    firstObservation,
    currentView,
    currentSongKey,
    hasQueue,
    playerState,
    entryView,
    isFmMode,
}: RotationInput): NightstandNavigationTarget | null => {
    if (isLandscape) return 'player';
    if (firstObservation) return null;
    if (currentView === 'lattice') return null;
    if (currentSongKey && hasQueue && playerState === PlayerState.PLAYING && entryView !== 'player' && !isFmMode) return 'lattice';
    return 'home';
};

type AutoOpenInput = {
    supported: boolean;
    isLandscape: boolean;
    isFmMode: boolean;
    entryView: PlaybackEntryView;
    currentView: AppView;
    currentSongKey: string | null;
    hasQueue: boolean;
    playerState: PlayerState;
    /** 这首歌已经进过拼贴（自动进入、手动点 Queue collage、或翻转进入都算）。 */
    handledSongKey: string | null;
    /**
     * 自动进拼贴还“上着膛”：冷启动后、或队列空过之后的第一次播放才拉人进拼贴。进过一次拼贴（自动或自己进）就退膛，
     * 之后已经有队列时，用户不在拼贴上就不再拉回去——换歌、自动播下一首、从别的歌单开始播都一样；
     * 只有队列被清空（或下次冷启动）才重新上膛。由 NightstandHost 维护。
     */
    autoOpenArmed?: boolean;
};

/**
 * 竖屏播放这首歌时要不要自动进队列拼贴。只认“真的在播放”：恢复出来的暂停会话不拉人，
 * 暂停中也不拉；同一首歌进过一次就不再拉（用户自己退回首页后留在首页）。
 * 只在冷启动或队列从空到有的第一次播放时拉（autoOpenArmed）：原来只记“上一首”，用户退回首页后下一首一来又被拉回
 * 拼贴，而每次重进拼贴都要重新建墙和歌词渲染，手机上切几次歌就顶到网页进程的内存上限（2026-11-21 真机日志）。
 */
export const shouldAutoOpenNightstandLattice = ({
    supported,
    isLandscape,
    isFmMode,
    entryView,
    currentView,
    currentSongKey,
    hasQueue,
    playerState,
    handledSongKey,
    autoOpenArmed = true,
}: AutoOpenInput): boolean => (
    supported
    && !isLandscape
    && !isFmMode
    && entryView === 'stay'
    && currentView === 'home'
    && Boolean(currentSongKey)
    && hasQueue
    && playerState === PlayerState.PLAYING
    && handledSongKey !== currentSongKey
    && autoOpenArmed
);
