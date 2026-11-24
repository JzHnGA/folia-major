import React, { useEffect, useState } from 'react';
import PlayerTrackSwipeHint from '../../src/components/app/player-swipe/PlayerTrackSwipeHint';
import { useAppViewStore } from '../../src/stores/useAppViewStore';
import type { ProbeDefinition } from './definition';

// dev/probes/playerSwipeHint.probe.tsx
// 播放页左右滑动切歌的箭头层：只挂这一层与两个计数，真实发 TouchEvent 看重放行为。
// 探针把 view 设成 player（手势只在播放页认），并放一颗按钮验证从按钮上起手不切歌。

const PlayerSwipeHintProbe: React.FC = () => {
    const [next, setNext] = useState(0);
    const [prev, setPrev] = useState(0);

    useEffect(() => {
        useAppViewStore.setState({ view: 'player' });
        return () => useAppViewStore.setState({ view: 'home' });
    }, []);

    return (
        <div className="relative h-screen bg-zinc-900 text-white" data-probe-player-swipe>
            <button type="button" data-probe-action="button" className="absolute left-6 top-6 z-40 rounded bg-white/10 px-3 py-1.5">
                a button
            </button>
            <div data-probe-ignore data-player-swipe-ignore className="absolute bottom-24 left-6 z-40 flex h-24 w-40 items-center justify-center rounded bg-white/5 text-xs">
                ignore region
            </div>
            {/* 像 Monet / Pendolo 的歌词轨：自己的 touch 处理器把冒泡截断。 */}
            <div
                data-probe-stopping
                role="button"
                tabIndex={0}
                className="absolute bottom-24 right-6 z-40 flex h-24 w-40 items-center justify-center rounded bg-white/5 text-xs"
                onTouchStart={event => event.stopPropagation()}
                onTouchMove={event => event.stopPropagation()}
            >
                stops propagation
            </div>
            <span className="absolute left-1/2 top-6 -translate-x-1/2 text-sm">
                next <span data-probe-next>{next}</span> · prev <span data-probe-prev>{prev}</span>
            </span>
            <PlayerTrackSwipeHint
                onNextTrack={() => setNext(value => value + 1)}
                onPrevTrack={() => setPrev(value => value + 1)}
            />
        </div>
    );
};

const probe: ProbeDefinition = {
    id: 'playerSwipeHint',
    title: 'Player swipe · 左右滑动切歌的箭头',
    description: '在播放页左右滑动切歌，箭头跟手并在提交时滑出。',
    Component: PlayerSwipeHintProbe,
};

export default probe;
