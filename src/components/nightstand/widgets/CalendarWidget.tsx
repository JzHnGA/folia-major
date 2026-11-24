// src/components/nightstand/widgets/CalendarWidget.tsx
// Nightstand 日历卡：三档都围绕「今天」和日程（与 Apple 日历小组件同一思路，HIG widgets › Best practices）：
// 小号是星期 + 大号日期 + 下一个日程（读不到日历时显示年月）；中号再列出接下来 3 个日程（读不到日历时换成本周的日期条）；
// 大号是迷你月历 + 接下来的日程。今天用主题文字色反白圈出。
// 原生壳里读系统日历（iCloud 等账户都汇进来）；网页/桌面没有日历接口，不显示日程。每分钟重取一次。

import { memo, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listTodayCalendarEvents, upcomingEvents, type CalendarEventInfo } from '../../../utils/system/calendarEvents';
import { cellFont, cellLength, type NightstandWidgetProps } from './nightstandWidgets';

const REFRESH_MS = 60 * 1000;
const MAX_EVENTS = { S: 1, M: 3, L: 3 } as const;

const DIVIDER = { borderColor: 'color-mix(in srgb, var(--text-primary) 15%, transparent)' };
const TODAY_MARK = { backgroundColor: 'var(--text-primary)', color: 'var(--bg-color)' };

/** 周一开头的 7 个星期缩写（与 Apple 一致；2024-01-01 是周一）。 */
const weekdayNames = (language: string): string[] => {
    const formatter = new Intl.DateTimeFormat(language, { weekday: 'narrow' });
    return Array.from({ length: 7 }, (_, i) => formatter.format(new Date(2024, 0, 1 + i)));
};

/** 日程列表：开始时间（或「全天」）+ 标题，一行一个。 */
const EventRows: React.FC<{ events: CalendarEventInfo[]; language: string }> = ({ events, language }) => {
    const { t } = useTranslation();
    const timeFormatter = new Intl.DateTimeFormat(language, { hour: '2-digit', minute: '2-digit', hour12: false });
    if (events.length === 0) {
        return <div className="opacity-60" style={{ fontSize: cellFont(0.1) }}>{t('nightstand.calendarNoEvents')}</div>;
    }
    return (
        <div className="flex min-w-0 flex-col gap-1">
            {events.map(event => (
                <div key={`${event.startDate}-${event.title}`} className="flex min-w-0 items-baseline gap-2" style={{ fontSize: cellFont(0.1) }}>
                    <span className="shrink-0 tabular-nums opacity-70">
                        {event.isAllDay ? t('nightstand.calendarAllDay') : timeFormatter.format(new Date(event.startDate))}
                    </span>
                    <span className="truncate">{event.title}</span>
                </div>
            ))}
        </div>
    );
};

const CalendarWidget: React.FC<NightstandWidgetProps> = ({ size }) => {
    const { t, i18n } = useTranslation();
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();
    const today = now.getDate();

    const [events, setEvents] = useState<CalendarEventInfo[] | null>(null);
    const [denied, setDenied] = useState(false);
    useEffect(() => {
        let cancelled = false;
        const load = () => {
            void listTodayCalendarEvents().then(result => {
                if (cancelled) return;
                setDenied(result.status === 'denied');
                setEvents(result.status === 'ready' ? result.events : null);
            });
        };
        load();
        const interval = window.setInterval(load, REFRESH_MS);
        return () => { cancelled = true; window.clearInterval(interval); };
    }, []);

    const upcoming = events ? upcomingEvents(events, Date.now(), MAX_EVENTS[size]) : [];
    const weekdayLong = new Intl.DateTimeFormat(i18n.language, { weekday: 'long' }).format(now);
    const weekdays = weekdayNames(i18n.language);

    // 星期 + 大号日期：小号和中号共用。
    const dayHeader = (
        <div className="flex shrink-0 flex-col">
            <span className="truncate font-medium opacity-70" style={{ fontSize: cellFont(0.1) }}>{weekdayLong}</span>
            <span className="leading-none tabular-nums" style={{ fontSize: cellFont(0.34), fontWeight: 400 }}>{today}</span>
        </div>
    );

    if (size === 'S') {
        const next = upcoming[0];
        return (
            <div className="flex h-full flex-col justify-between">
                {dayHeader}
                <div className="line-clamp-2 leading-snug" style={{ fontSize: cellFont(0.095) }}>
                    {next ? next.title : (
                        <span className="opacity-60">
                            {events === null
                                ? new Intl.DateTimeFormat(i18n.language, { year: 'numeric', month: 'long' }).format(now)
                                : t('nightstand.calendarNoEvents')}
                        </span>
                    )}
                </div>
            </div>
        );
    }

    if (size === 'M') {
        // 读不到日历（网页、未授权）时右边放本周的日期条，今天圈出。
        const monday = new Date(year, month, today - ((now.getDay() + 6) % 7));
        return (
            <div className="flex h-full gap-3">
                <div className="flex w-[34%] flex-col justify-between">
                    {dayHeader}
                    <span className="truncate opacity-60" style={{ fontSize: cellFont(0.09) }}>
                        {new Intl.DateTimeFormat(i18n.language, { month: 'long' }).format(now)}
                    </span>
                </div>
                <div className="flex min-w-0 flex-1 flex-col justify-center border-l pl-3" style={DIVIDER}>
                    {events !== null ? (
                        <EventRows events={upcoming} language={i18n.language} />
                    ) : (
                        <div className="grid grid-cols-7 gap-y-1 text-center">
                            {weekdays.map((day, i) => <span key={i} className="opacity-60" style={{ fontSize: cellFont(0.085) }}>{day}</span>)}
                            {Array.from({ length: 7 }, (_, i) => new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i)).map(date => {
                                const isToday = date.getDate() === today && date.getMonth() === month;
                                return (
                                    <span
                                        key={date.getTime()}
                                        className="mx-auto flex items-center justify-center rounded-full tabular-nums"
                                        style={{ width: cellLength(0.19), height: cellLength(0.19), fontSize: cellFont(0.1), ...(isToday ? TODAY_MARK : {}) }}
                                    >
                                        {date.getDate()}
                                    </span>
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>
        );
    }

    const firstOfMonth = new Date(year, month, 1);
    const leadingBlanks = (firstOfMonth.getDay() + 6) % 7; // 周日=0 → 6 个空格
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const monthTitle = new Intl.DateTimeFormat(i18n.language, { year: 'numeric', month: 'long' }).format(now);
    const cells: (number | null)[] = [
        ...Array.from({ length: leadingBlanks }, () => null),
        ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
    ];
    const dayCell = cellLength(0.145);

    return (
        <div className="flex h-full flex-col gap-1.5">
            <div className="font-medium" style={{ fontSize: cellFont(0.12) }}>{monthTitle}</div>
            <div className="grid grid-cols-7 text-center opacity-60" style={{ fontSize: cellFont(0.085) }}>
                {weekdays.map((day, i) => <span key={i}>{day}</span>)}
            </div>
            <div className="grid grid-cols-7 gap-y-0.5 text-center tabular-nums" style={{ fontSize: cellFont(0.095) }}>
                {cells.map((day, i) => (
                    <span
                        key={i}
                        className="mx-auto flex items-center justify-center rounded-full"
                        style={{ width: dayCell, height: dayCell, ...(day === today ? TODAY_MARK : {}) }}
                    >
                        {day}
                    </span>
                ))}
            </div>
            {events !== null && (
                <div className="mt-auto border-t pt-1.5" style={DIVIDER}>
                    <EventRows events={upcoming} language={i18n.language} />
                </div>
            )}
            {denied && <div className="mt-auto opacity-50" style={{ fontSize: cellFont(0.085) }}>{t('nightstand.calendarNoAccess')}</div>}
        </div>
    );
};

export default memo(CalendarWidget);
