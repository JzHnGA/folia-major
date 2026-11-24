// src/components/nightstand/widgets/HitokotoWidget.tsx
// Nightstand 一言卡：hitokoto.cn 的文学/诗词/哲思句（免 key、允许跨域），10 分钟换一句。
// 档位：只有中号和大号（1×1 放不下一句话）。中号句子最多 3 行 + 出处；大号放大句子、不截断，出处写全「作者《作品》」。

import { memo, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cellFont, type NightstandWidgetProps } from './nightstandWidgets';

type QuoteState =
    | { status: 'loading' }
    | { status: 'ready'; text: string; fromWho: string | null; from: string | null }
    | { status: 'unavailable' };

const REFRESH_MS = 10 * 60 * 1000;

/** hitokoto.cn 响应里我们关心的三个字段。 */
interface HitokotoResponse {
    hitokoto?: unknown;
    from_who?: unknown;
    from?: unknown;
}

const fetchQuote = async (): Promise<Extract<QuoteState, { status: 'ready' }>> => {
    const response = await fetch('https://v1.hitokoto.cn/?c=d&c=i&c=k');
    if (!response.ok) throw new Error('hitokoto failed');
    const data = (await response.json()) as HitokotoResponse;
    if (typeof data.hitokoto !== 'string' || !data.hitokoto) throw new Error('bad hitokoto');
    const fromWho = typeof data.from_who === 'string' && data.from_who ? data.from_who : null;
    const from = typeof data.from === 'string' && data.from ? data.from : null;
    return { status: 'ready', text: data.hitokoto, fromWho, from };
};

const HitokotoWidget: React.FC<NightstandWidgetProps> = ({ size }) => {
    const { t } = useTranslation();
    const [quote, setQuote] = useState<QuoteState>({ status: 'loading' });

    useEffect(() => {
        let cancelled = false;
        const load = () => {
            fetchQuote()
                .then(result => { if (!cancelled) setQuote(result); })
                .catch(() => { if (!cancelled) setQuote({ status: 'unavailable' }); });
        };
        load();
        const interval = window.setInterval(load, REFRESH_MS);
        return () => { cancelled = true; window.clearInterval(interval); };
    }, []);

    if (quote.status !== 'ready') {
        return (
            <div className="flex h-full flex-col justify-center gap-1">
                <div className="opacity-70" style={{ fontSize: cellFont(0.11) }}>
                    {quote.status === 'loading' ? '…' : t('nightstand.hitokotoUnavailable')}
                </div>
            </div>
        );
    }

    if (size === 'L') {
        const source = quote.fromWho && quote.from ? `${quote.fromWho}《${quote.from}》` : quote.fromWho ?? (quote.from ? `《${quote.from}》` : null);
        return (
            <div className="flex h-full flex-col justify-center gap-3">
                <div className="line-clamp-[8] leading-snug" style={{ fontSize: cellFont(0.15) }}>{quote.text}</div>
                {source && <div className="truncate opacity-60" style={{ fontSize: cellFont(0.1) }}>—— {source}</div>}
            </div>
        );
    }

    const source = quote.fromWho ?? quote.from;
    return (
        <div className="flex h-full flex-col justify-center gap-1.5">
            <div className="line-clamp-3 leading-snug" style={{ fontSize: cellFont(0.12) }}>{quote.text}</div>
            {source && <div className="truncate opacity-60" style={{ fontSize: cellFont(0.095) }}>—— {source}</div>}
        </div>
    );
};

export default memo(HitokotoWidget);
