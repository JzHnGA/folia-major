// src/components/nightstand/widgets/ClockWidget.tsx
// Nightstand 时钟卡：小号只有时间和简短日期；中号大号时间 + 完整日期；
// 大号再加农历（中文界面）和第几周、今年第几天。一秒一拍离散更新（分钟精度，按秒对齐避免边界漂移）。

import { memo, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cellFont, type NightstandWidgetProps } from './nightstandWidgets';

const useNightstandClock = (): Date => {
    const [now, setNow] = useState(() => new Date());
    useEffect(() => {
        const tick = () => setNow(new Date());
        const interval = window.setInterval(tick, 1000);
        return () => window.clearInterval(interval);
    }, []);
    return now;
};

/** ISO 周数：周一开头，本周的周四落在哪一年、是那年的第几个周四。 */
const isoWeekOf = (date: Date): number => {
    const day = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const weekday = day.getUTCDay() || 7;
    day.setUTCDate(day.getUTCDate() + 4 - weekday);
    const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1);
    return Math.ceil(((day.getTime() - yearStart) / 86_400_000 + 1) / 7);
};

const dayOfYear = (date: Date): number => {
    const start = new Date(date.getFullYear(), 0, 1);
    const today = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    return Math.round((today.getTime() - start.getTime()) / 86_400_000) + 1;
};

/** 农历月日（如「十月初五」）；不支持中国历法的环境返回 null。 */
const lunarDateOf = (date: Date): string | null => {
    try {
        const parts = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', { month: 'long', day: 'numeric' }).formatToParts(date);
        const month = parts.find(part => part.type === 'month')?.value;
        const day = parts.find(part => part.type === 'day')?.value;
        if (!month || !day) return null;
        const dayNumber = Number(day);
        return `${month}${Number.isFinite(dayNumber) ? lunarDayName(dayNumber) : day}`;
    } catch {
        return null;
    }
};

const LUNAR_DIGITS = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
/** 农历日 1–30 → 初一 … 三十。 */
const lunarDayName = (day: number): string => {
    if (day === 10) return '初十';
    if (day === 20) return '二十';
    if (day === 30) return '三十';
    const tens = ['初', '十', '廿', '三'][Math.floor(day / 10)];
    return `${tens}${LUNAR_DIGITS[day % 10]}`;
};

const ClockWidget: React.FC<NightstandWidgetProps> = ({ size }) => {
    const { t, i18n } = useTranslation();
    const now = useNightstandClock();

    const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    if (size === 'S') {
        const shortDate = new Intl.DateTimeFormat(i18n.language, { month: 'short', day: 'numeric', weekday: 'short' }).format(now);
        return (
            <div className="flex h-full flex-col justify-between">
                <div className="truncate opacity-70" style={{ fontSize: cellFont(0.1) }}>{shortDate}</div>
                <div className="leading-none tabular-nums tracking-tight" style={{ fontSize: cellFont(0.27), fontWeight: 400 }}>
                    {time}
                </div>
            </div>
        );
    }

    const date = new Intl.DateTimeFormat(i18n.language, { month: 'long', day: 'numeric', weekday: 'long' }).format(now);

    if (size === 'M') {
        return (
            <div className="flex h-full flex-col justify-center gap-1">
                <div className="leading-none tabular-nums tracking-tight" style={{ fontSize: cellFont(0.5), fontWeight: 300 }}>
                    {time}
                </div>
                <div className="truncate opacity-70" style={{ fontSize: cellFont(0.13) }}>{date}</div>
            </div>
        );
    }

    const lunar = i18n.language.startsWith('zh') ? lunarDateOf(now) : null;
    return (
        <div className="flex h-full flex-col justify-between">
            <div className="flex flex-col gap-1">
                <div className="leading-none tabular-nums tracking-tight" style={{ fontSize: cellFont(0.6), fontWeight: 300 }}>
                    {time}
                </div>
                <div className="opacity-70" style={{ fontSize: cellFont(0.14) }}>{date}</div>
            </div>
            <div
                className="flex flex-col gap-1 border-t pt-2 opacity-70"
                style={{ fontSize: cellFont(0.11), borderColor: 'color-mix(in srgb, var(--text-primary) 15%, transparent)' }}
            >
                {lunar && <div>{t('nightstand.clockLunar', { date: lunar })}</div>}
                <div>
                    {t('nightstand.clockWeek', { week: isoWeekOf(now) })} · {t('nightstand.clockDayOfYear', { day: dayOfYear(now) })}
                </div>
            </div>
        </div>
    );
};

export default memo(ClockWidget);
