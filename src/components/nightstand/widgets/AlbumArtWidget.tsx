// src/components/nightstand/widgets/AlbumArtWidget.tsx
// Nightstand 专辑封面卡：小号只有封面；中号封面 + 歌名、歌手、专辑；大号大封面 + 下方完整歌曲信息。
// 没播放时这张卡整个不出现（NightstandOverlay 按 currentSong 过滤）。

import { memo } from 'react';
import { Music } from 'lucide-react';
import { usePlaybackStore } from '../../../stores/usePlaybackStore';
import { cellFont, cellLength, type NightstandWidgetProps } from './nightstandWidgets';

/** 封面图；没有封面时用音符占位。 */
const Cover: React.FC<{ url: string | null; alt: string; className?: string; style?: React.CSSProperties }> = ({ url, alt, className = '', style }) =>
    url ? (
        <img src={url} alt={alt} className={`aspect-square rounded-2xl object-cover ${className}`} style={style} draggable={false} />
    ) : (
        <div className={`flex aspect-square items-center justify-center rounded-2xl bg-white/10 ${className}`} style={style}>
            <Music style={{ width: cellLength(0.25), height: cellLength(0.25) }} strokeWidth={1.5} />
        </div>
    );

const AlbumArtWidget: React.FC<NightstandWidgetProps> = ({ size }) => {
    const coverUrl = usePlaybackStore(state => state.cachedCoverUrl);
    const currentSong = usePlaybackStore(state => state.currentSong);

    // 未播放时这张卡整个不出现（NightstandOverlay 按 currentSong 过滤），这里兜底。
    if (!currentSong) return null;

    const artists = currentSong.artists.map(artist => artist.name).filter(Boolean).join(' / ');
    const album = currentSong.album.name;

    if (size === 'S') return <Cover url={coverUrl} alt={currentSong.name} className="h-full w-full" />;

    const info = (
        <div className="flex min-w-0 flex-col gap-0.5">
            <div className={size === 'L' ? 'truncate font-medium' : 'line-clamp-2 font-medium leading-snug'} style={{ fontSize: cellFont(0.12) }}>
                {currentSong.name}
            </div>
            {artists && <div className="truncate opacity-80" style={{ fontSize: cellFont(0.1) }}>{artists}</div>}
            {album && <div className="truncate opacity-60" style={{ fontSize: cellFont(0.095) }}>{album}</div>}
        </div>
    );

    if (size === 'M') {
        return (
            <div className="flex h-full items-center gap-3">
                <Cover url={coverUrl} alt={currentSong.name} className="h-full shrink-0" />
                {info}
            </div>
        );
    }

    return (
        <div className="flex h-full flex-col gap-2">
            <Cover url={coverUrl} alt={currentSong.name} className="min-h-0 flex-1 self-start" />
            {info}
        </div>
    );
};

export default memo(AlbumArtWidget);
