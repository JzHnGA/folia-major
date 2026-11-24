// src/components/nightstand/NightstandHost.tsx
// Nightstand 模式的总控：
// 1. iOS 首启默认「播放后进入的视图 = 留在原处」、资料库界面保持 Bravais，并标记引导已回答；
// 2. 方向翻转时切换视图——横屏进可视化播放页，竖屏默认去队列拼贴（真的有歌在播时）/ 首页；
//    已经停在队列拼贴上时竖屏也留在原处；只在翻转瞬间导航，不持续强占视图，用户在同一方向下仍可自由走动；
// 3. 竖屏播放一首歌时自动进入队列拼贴（横屏「Queue collage」按钮同一个效果），不用先点按钮；
//    只在冷启动或队列从空到有的第一次播放时拉；已经有队列时，人不在拼贴上就不再拉回（换歌、自动下一首、换歌单都一样）；
//    恢复出来的暂停会话、暂停状态都不拉人；
// 4. 横屏且停留在播放页时叠加床头钟（时间 + 当前歌曲），动态歌词由可视化视图自己渲染。
// 方向变化和自动进拼贴都可能在设置、登录、教程、搜索开着时发生：那时先不导航。
// 翻转会一直等到它们关掉再补上；自动进拼贴最多等 10 秒（同一首歌还能靠下一次状态变化重试）。

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppView } from '../../stores/useAppViewStore';
import type { Theme } from '../../types';
import { usePlaybackEntryViewStore } from '../../stores/usePlaybackEntryViewStore';
import { selectDisplayPlayerState, usePlaybackStore } from '../../stores/usePlaybackStore';
import { useSearchNavigationStore } from '../../stores/useSearchNavigationStore';
import { getPlaybackSongKey } from '../../utils/appPlaybackGuards';
import { isNightstandSupported } from './nightstandPlatform';
import { useIsLandscape } from './useIsLandscape';
import NightstandOverlay from './NightstandOverlay';
import { resolveNightstandRotationTarget, shouldAutoOpenNightstandLattice } from './nightstandPlaybackNavigation';
import { hasBlockingWindow, hasOpenSheet, isTextEntryTarget } from '../../utils/keyboardTargets';

type NightstandHostProps = {
    currentView: AppView;
    theme: Theme;
    isDaylight: boolean;
    navigateToPlayer: () => void;
    navigateToHome: () => void;
    navigateToLattice: () => void;
};

/** 阻塞界面关掉之前，方向翻转 / 自动进拼贴最多等这么久（500ms 一次）。 */
const BLOCKED_RETRY_LIMIT = 20;

const NightstandHost: React.FC<NightstandHostProps> = ({
    currentView,
    theme,
    isDaylight,
    navigateToPlayer,
    navigateToHome,
    navigateToLattice,
}) => {
    const [supported] = useState(() => isNightstandSupported());
    const isLandscape = useIsLandscape();
    const currentSongKey = usePlaybackStore(state => (state.currentSong ? getPlaybackSongKey(state.currentSong) : null));
    const hasQueue = usePlaybackStore(state => state.playQueue.length > 0);
    const playerState = usePlaybackStore(selectDisplayPlayerState);
    const isFmMode = usePlaybackStore(state => state.isFmMode);
    const entryView = usePlaybackEntryViewStore(state => state.playbackEntryView);

    // 设置、登录、教程、搜索或输入框开着时不切：方向翻转 / 自动进入拼贴都不该把正在做的事顶掉。
    const canNavigate = useCallback(() => !hasBlockingWindow()
        && !hasOpenSheet()
        && !useSearchNavigationStore.getState().isSearchOpen
        && !isTextEntryTarget(document.activeElement), []);

    // 首启默认值：移动端按播放留在 Bravais 墙上；两页首启引导标记为已回答（默认即期望答案）。
    useEffect(() => {
        if (!supported) return;
        const store = usePlaybackEntryViewStore.getState();
        // 「可视化」只随横屏进入，不再是可选项；旧装机里存着的 player 也改成 stay。
        if (!store.hasChosenPlaybackEntryView || store.playbackEntryView === 'player') store.setPlaybackEntryView('stay');
        store.closePlaybackEntryViewPrompt();
    }, [supported]);

    // 翻转 effect 只在方向变化时跑一次；其余值经 live 取最新的，避免 entryView 等 store 更新把这次等待中的导航取消掉。
    const live = useRef({ currentView, currentSongKey, hasQueue, playerState, entryView, isFmMode, canNavigate, navigateToPlayer, navigateToHome, navigateToLattice });
    live.current = { currentView, currentSongKey, hasQueue, playerState, entryView, isFmMode, canNavigate, navigateToPlayer, navigateToHome, navigateToLattice };
    /** 已经为哪一首进过拼贴（自动、翻转、手动点按钮都算）；换歌或歌停下来时清掉。 */
    const handledSongRef = useRef<string | null>(null);
    /**
     * 自动进拼贴是否还上着膛（shouldAutoOpenNightstandLattice 的 autoOpenArmed）：冷启动时上膛，队列清空时重新上膛；
     * 人一到过拼贴（自动拉进去、自己点进去、翻转进去）就退膛。之后已经有队列时不再把人从首页拉回拼贴。
     */
    const autoOpenArmedRef = useRef(true);

    const previousLandscape = useRef<boolean | null>(null);
    useEffect(() => {
        if (!supported) return;
        const previous = previousLandscape.current;
        previousLandscape.current = isLandscape;
        if (previous === isLandscape) return;
        const firstObservation = previous === null;
        let timer = 0;
        // 推迟一拍再导航：子组件 effect 先于 App 的启动导航执行，直接调会被启动态覆盖（横屏直接启动时留在首页）。
        const run = () => {
            const now = live.current;
            if (!now.canNavigate()) {
                // 设置 / 登录 / 教程可能开着很久：一直等它关掉再补这次翻转（方向再变时由 cleanup 停掉）。
                timer = window.setTimeout(run, 500);
                return;
            }
            const target = resolveNightstandRotationTarget({
                isLandscape,
                firstObservation,
                currentView: now.currentView,
                currentSongKey: now.currentSongKey,
                hasQueue: now.hasQueue,
                playerState: now.playerState,
                entryView: now.entryView,
                isFmMode: now.isFmMode,
            });
            if (target === 'player') now.navigateToPlayer();
            else if (target === 'lattice') {
                handledSongRef.current = now.currentSongKey;
                now.navigateToLattice();
            } else if (target === 'home') now.navigateToHome();
        };
        timer = window.setTimeout(run, isLandscape ? 120 : 0);
        return () => window.clearTimeout(timer);
        // 只在方向真的翻转时重跑；其余状态经 live 读取。
    }, [supported, isLandscape]);

    // 队列清空：下一次从空队列开始播放算「第一次」，重新允许自动进拼贴。
    useEffect(() => {
        if (!hasQueue) autoOpenArmedRef.current = true;
    }, [hasQueue]);

    // 竖屏播放：冷启动或队列从空到有的第一次播放时自动进入队列拼贴，和横屏按「Queue collage」同一个效果。
    useEffect(() => {
        if (!supported) return;
        if (!currentSongKey) {
            handledSongRef.current = null;
            return;
        }
        // 已经在拼贴上（手动点按钮 / 翻转进来）：这首歌算进过了，也退膛——用户退回首页后，之后换歌不再自动拉走。
        if (currentView === 'lattice') {
            handledSongRef.current = currentSongKey;
            autoOpenArmedRef.current = false;
            return;
        }
        if (!shouldAutoOpenNightstandLattice({
            supported,
            isLandscape,
            isFmMode,
            entryView,
            currentView,
            currentSongKey,
            hasQueue,
            playerState,
            handledSongKey: handledSongRef.current,
            autoOpenArmed: autoOpenArmedRef.current,
        })) return;
        let attempts = 0;
        let timer = 0;
        const tryNavigate = () => {
            if (!canNavigate()) {
                attempts += 1;
                if (attempts < BLOCKED_RETRY_LIMIT) timer = window.setTimeout(tryNavigate, 500);
                return;
            }
            handledSongRef.current = currentSongKey;
            autoOpenArmedRef.current = false;
            navigateToLattice();
        };
        timer = window.setTimeout(tryNavigate, 160);
        return () => window.clearTimeout(timer);
    }, [supported, isLandscape, isFmMode, entryView, currentView, currentSongKey, hasQueue, playerState, canNavigate, navigateToLattice]);

    if (!supported) return null;

    return (
        <>
            {isLandscape && currentView === 'player' && (
                <NightstandOverlay theme={theme} isDaylight={isDaylight} />
            )}
        </>
    );
};

export default NightstandHost;
