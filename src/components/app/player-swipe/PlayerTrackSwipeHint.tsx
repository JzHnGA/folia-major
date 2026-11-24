import React, { useRef } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { usePlayerTrackSwipe } from './usePlayerTrackSwipe';
import './playerTrackSwipe.css';

// src/components/app/player-swipe/PlayerTrackSwipeHint.tsx
// 播放页左右滑动切歌的箭头层：只画两侧的箭头，显隐与动画由手势直接写 CSS 变量 / data 属性。
// 层本身 pointer-events: none，不挡歌词、进度条与底部播放条。

type PlayerTrackSwipeHintProps = {
    onNextTrack: () => void;
    onPrevTrack: () => void;
    enabled?: boolean;
};

const PlayerTrackSwipeHint: React.FC<PlayerTrackSwipeHintProps> = ({ onNextTrack, onPrevTrack, enabled = true }) => {
    const feedbackRef = useRef<HTMLDivElement>(null);
    usePlayerTrackSwipe({ onNextTrack, onPrevTrack, feedbackRef, enabled });

    return (
        <div ref={feedbackRef} className="player-swipe-hint" data-testid="player-swipe-hint" aria-hidden="true">
            <span className="player-swipe-arrow player-swipe-arrow--prev">
                <ChevronLeft size={52} strokeWidth={1.6} />
            </span>
            <span className="player-swipe-arrow player-swipe-arrow--next">
                <ChevronRight size={52} strokeWidth={1.6} />
            </span>
        </div>
    );
};

export default PlayerTrackSwipeHint;
