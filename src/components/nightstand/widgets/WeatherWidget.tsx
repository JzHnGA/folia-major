// src/components/nightstand/widgets/WeatherWidget.tsx
// Nightstand 天气卡：Open-Meteo（免 key、允许跨域）取当前天气、逐小时和逐日预报，城市名走 BigDataCloud 逆地理（免 key）。
// 定位用浏览器 geolocation，拒绝授权时退到 ipapi.co 的大概位置，再不行显示「不可用」。30 分钟刷新一次。
// iOS 壳里 geolocation 需要 Info.plist 的 NSLocationWhenInUseUsageDescription（已在工程里配置）。
// 档位：小号当前温度 + 天气 + 最高最低；中号再加接下来 4 小时；大号再加接下来 6 小时和 4 天预报。
// 预报一次取全，换档不用重新请求。

import { memo, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
    Cloud,
    CloudDrizzle,
    CloudFog,
    CloudLightning,
    CloudMoon,
    CloudRain,
    CloudSnow,
    CloudSun,
    Moon,
    Sun,
    Thermometer,
    type LucideIcon,
} from 'lucide-react';
import { cellFont, cellLength, type NightstandWidgetProps } from './nightstandWidgets';

type HourForecast = { hour: number; temperature: number; code: number; isDay: boolean };
type DayForecast = { date: Date; code: number; max: number; min: number };

type WeatherState =
    | { status: 'loading' }
    | {
        status: 'ready';
        temperature: number;
        code: number;
        isDay: boolean;
        city: string | null;
        high: number | null;
        low: number | null;
        hourly: HourForecast[];
        daily: DayForecast[];
    }
    | { status: 'unavailable' };

const REFRESH_MS = 30 * 60 * 1000;
const HOURS_AHEAD = 6;
const DAYS_AHEAD = 4;

/** WMO 天气码 → 图标与文案键。 */
const describeWeatherCode = (code: number, isDay: boolean): { icon: LucideIcon; labelKey: string } => {
    if (code === 0) return { icon: isDay ? Sun : Moon, labelKey: 'weatherClear' };
    if (code <= 2) return { icon: isDay ? CloudSun : CloudMoon, labelKey: 'weatherPartly' };
    if (code === 3) return { icon: Cloud, labelKey: 'weatherCloudy' };
    if (code === 45 || code === 48) return { icon: CloudFog, labelKey: 'weatherFog' };
    if (code >= 51 && code <= 57) return { icon: CloudDrizzle, labelKey: 'weatherDrizzle' };
    if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return { icon: CloudRain, labelKey: 'weatherRain' };
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return { icon: CloudSnow, labelKey: 'weatherSnow' };
    if (code >= 95) return { icon: CloudLightning, labelKey: 'weatherThunder' };
    return { icon: Cloud, labelKey: 'weatherCloudy' };
};

const locate = (): Promise<{ latitude: number; longitude: number }> =>
    new Promise((resolve, reject) => {
        if (!('geolocation' in navigator)) return reject(new Error('no geolocation'));
        navigator.geolocation.getCurrentPosition(
            position => resolve({ latitude: position.coords.latitude, longitude: position.coords.longitude }),
            () => reject(new Error('denied')),
            { timeout: 8000, maximumAge: REFRESH_MS },
        );
    });

/** 定位被拒时的退路：按 IP 取城市级坐标，精度够天气用。 */
interface IpLocationResponse {
    latitude?: unknown;
    longitude?: unknown;
}

const locateByIp = async (): Promise<{ latitude: number; longitude: number }> => {
    const response = await fetch('https://ipapi.co/json/');
    if (!response.ok) throw new Error('ip location failed');
    const data = (await response.json()) as IpLocationResponse;
    if (typeof data.latitude !== 'number' || typeof data.longitude !== 'number') throw new Error('bad ip location');
    return { latitude: data.latitude, longitude: data.longitude };
};

/** 坐标 → 城市名；失败只是不显示，不算错误。 */
interface ReverseGeocodeResponse {
    city?: unknown;
    locality?: unknown;
    principalSubdivision?: unknown;
}

const fetchCityName = async (latitude: number, longitude: number, language: string): Promise<string | null> => {
    try {
        const locale = language.startsWith('zh') ? 'zh' : language.slice(0, 2);
        const response = await fetch(
            `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${latitude}&longitude=${longitude}&localityLanguage=${locale}`,
        );
        if (!response.ok) return null;
        const data = (await response.json()) as ReverseGeocodeResponse;
        const candidates = [data.city, data.locality, data.principalSubdivision];
        const name = candidates.find((value): value is string => typeof value === 'string' && value.length > 0);
        return name ?? null;
    } catch {
        return null;
    }
};

/** Open-Meteo 响应里我们关心的几段。时间都是所在地的本地时间（timezone=auto），形如 2026-11-24T14:00。 */
interface OpenMeteoResponse {
    current?: {
        time?: unknown;
        temperature_2m?: unknown;
        weather_code?: unknown;
        is_day?: unknown;
    };
    hourly?: {
        time?: unknown;
        temperature_2m?: unknown;
        weather_code?: unknown;
        is_day?: unknown;
    };
    daily?: {
        time?: unknown;
        weather_code?: unknown;
        temperature_2m_max?: unknown;
        temperature_2m_min?: unknown;
    };
}

const numbersOf = (value: unknown): number[] => (Array.isArray(value) ? value.map(item => (typeof item === 'number' ? item : Number.NaN)) : []);
const stringsOf = (value: unknown): string[] => (Array.isArray(value) ? value.map(item => (typeof item === 'string' ? item : '')) : []);

/** 当前整点之后的几个小时（不含当前这一小时，「现在」由当前天气给出）。 */
const parseHourly = (data: OpenMeteoResponse, currentTime: string): HourForecast[] => {
    const times = stringsOf(data.hourly?.time);
    const temperatures = numbersOf(data.hourly?.temperature_2m);
    const codes = numbersOf(data.hourly?.weather_code);
    const isDay = numbersOf(data.hourly?.is_day);
    const start = times.findIndex(time => time > currentTime);
    if (start < 0) return [];
    const hours: HourForecast[] = [];
    for (let i = start; i < times.length && hours.length < HOURS_AHEAD; i += 1) {
        const hour = Number(times[i].slice(11, 13));
        if (!Number.isFinite(hour) || !Number.isFinite(temperatures[i]) || !Number.isFinite(codes[i])) continue;
        hours.push({ hour, temperature: temperatures[i], code: codes[i], isDay: isDay[i] !== 0 });
    }
    return hours;
};

const parseDaily = (data: OpenMeteoResponse): DayForecast[] => {
    const days = stringsOf(data.daily?.time);
    const codes = numbersOf(data.daily?.weather_code);
    const maxes = numbersOf(data.daily?.temperature_2m_max);
    const mins = numbersOf(data.daily?.temperature_2m_min);
    const result: DayForecast[] = [];
    days.forEach((day, i) => {
        const [year, month, date] = day.split('-').map(Number);
        if (!year || !month || !date || !Number.isFinite(codes[i]) || !Number.isFinite(maxes[i]) || !Number.isFinite(mins[i])) return;
        result.push({ date: new Date(year, month - 1, date), code: codes[i], max: maxes[i], min: mins[i] });
    });
    return result.slice(0, DAYS_AHEAD);
};

const fetchWeather = async (language: string): Promise<Extract<WeatherState, { status: 'ready' }>> => {
    let coords: { latitude: number; longitude: number };
    try {
        coords = await locate();
    } catch {
        coords = await locateByIp();
    }
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${coords.latitude}&longitude=${coords.longitude}`
        + '&current=temperature_2m,weather_code,is_day'
        + '&hourly=temperature_2m,weather_code,is_day&forecast_hours=24'
        + `&daily=weather_code,temperature_2m_max,temperature_2m_min&forecast_days=${DAYS_AHEAD}`
        + '&timezone=auto';
    const [response, city] = await Promise.all([
        fetch(url),
        fetchCityName(coords.latitude, coords.longitude, language),
    ]);
    if (!response.ok) throw new Error('weather failed');
    const data = (await response.json()) as OpenMeteoResponse;
    const temperature = data.current?.temperature_2m;
    const code = data.current?.weather_code;
    if (typeof temperature !== 'number' || typeof code !== 'number') throw new Error('bad weather');
    const currentTime = typeof data.current?.time === 'string' ? data.current.time : '';
    const daily = parseDaily(data);
    return {
        status: 'ready',
        temperature,
        code,
        isDay: data.current?.is_day !== 0,
        city,
        high: daily[0]?.max ?? null,
        low: daily[0]?.min ?? null,
        hourly: currentTime ? parseHourly(data, currentTime) : [],
        daily,
    };
};

const degrees = (value: number) => `${Math.round(value)}°`;

/** 一个小时的预报：几点、图标、温度，竖排。 */
const HourColumn: React.FC<{ label: string; code: number; isDay: boolean; temperature: number }> = ({ label, code, isDay, temperature }) => {
    const Icon = describeWeatherCode(code, isDay).icon;
    return (
        <div className="flex min-w-0 flex-1 flex-col items-center gap-1">
            <span className="tabular-nums opacity-60" style={{ fontSize: cellFont(0.09) }}>{label}</span>
            <Icon style={{ width: cellLength(0.15), height: cellLength(0.15) }} strokeWidth={1.75} />
            <span className="tabular-nums" style={{ fontSize: cellFont(0.1) }}>{degrees(temperature)}</span>
        </div>
    );
};

const WeatherWidget: React.FC<NightstandWidgetProps> = ({ size }) => {
    const { t, i18n } = useTranslation();
    const [weather, setWeather] = useState<WeatherState>({ status: 'loading' });

    useEffect(() => {
        let cancelled = false;
        const load = () => {
            fetchWeather(i18n.language)
                .then(result => { if (!cancelled) setWeather(result); })
                .catch(() => { if (!cancelled) setWeather({ status: 'unavailable' }); });
        };
        load();
        const interval = window.setInterval(load, REFRESH_MS);
        return () => { cancelled = true; window.clearInterval(interval); };
    }, [i18n.language]);

    if (weather.status !== 'ready') {
        return (
            <div className="flex h-full flex-col justify-center gap-1">
                {weather.status === 'unavailable'
                    ? <Thermometer style={{ width: cellLength(0.22), height: cellLength(0.22) }} strokeWidth={1.75} />
                    : <div className="opacity-50" style={{ fontSize: cellFont(0.22) }}>…</div>}
                <div className="opacity-70" style={{ fontSize: cellFont(0.11) }}>
                    {t(weather.status === 'unavailable' ? 'nightstand.weatherUnavailable' : 'nightstand.weatherLocating')}
                </div>
            </div>
        );
    }

    const { icon: Icon, labelKey } = describeWeatherCode(weather.code, weather.isDay);
    const condition = t(`nightstand.${labelKey}`);
    const highLow = weather.high !== null && weather.low !== null
        ? t('nightstand.weatherHighLow', { high: Math.round(weather.high), low: Math.round(weather.low) })
        : null;

    // 当前温度、天气、最高最低：三档共用的头部，小号就只有它。
    const summary = (
        <div className="flex min-w-0 flex-col justify-between">
            <div className="flex min-w-0 items-center gap-1.5">
                <Icon className="shrink-0" style={{ width: cellLength(0.15), height: cellLength(0.15) }} strokeWidth={1.75} />
                <span className="truncate opacity-80" style={{ fontSize: cellFont(0.1) }}>
                    {size === 'S' || !weather.city ? condition : weather.city}
                </span>
            </div>
            <div className="leading-none tracking-tight" style={{ fontSize: cellFont(0.34), fontWeight: 300 }}>
                {degrees(weather.temperature)}
            </div>
            <div className="truncate opacity-70" style={{ fontSize: cellFont(0.095) }}>
                {size === 'S' ? highLow : [condition, highLow].filter(Boolean).join(' · ')}
            </div>
        </div>
    );

    if (size === 'S') return <div className="flex h-full flex-col justify-between">{summary}</div>;

    const hourLabel = (hour: number) => String(hour).padStart(2, '0');

    if (size === 'M') {
        return (
            <div className="flex h-full gap-3">
                <div className="flex w-[42%] shrink-0 flex-col justify-between">{summary}</div>
                <div className="flex min-w-0 flex-1 items-center">
                    {weather.hourly.slice(0, 4).map(hour => (
                        <HourColumn key={hour.hour} label={hourLabel(hour.hour)} code={hour.code} isDay={hour.isDay} temperature={hour.temperature} />
                    ))}
                </div>
            </div>
        );
    }

    // 大号：头部 + 逐小时 + 4 天预报（温度区间条按这几天的最低到最高画）。
    const weekdayFormatter = new Intl.DateTimeFormat(i18n.language, { weekday: 'short' });
    const rangeMin = Math.min(...weather.daily.map(day => day.min));
    const rangeMax = Math.max(...weather.daily.map(day => day.max));
    const span = Math.max(1, rangeMax - rangeMin);
    const divider = { borderColor: 'color-mix(in srgb, var(--text-primary) 15%, transparent)' };
    return (
        <div className="flex h-full flex-col justify-between gap-2">
            <div className="flex items-end justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-1">
                    <span className="truncate opacity-80" style={{ fontSize: cellFont(0.11) }}>{weather.city ?? condition}</span>
                    <span className="leading-none tracking-tight" style={{ fontSize: cellFont(0.34), fontWeight: 300 }}>
                        {degrees(weather.temperature)}
                    </span>
                </div>
                <div className="flex min-w-0 flex-col items-end gap-1 text-right">
                    <Icon style={{ width: cellLength(0.17), height: cellLength(0.17) }} strokeWidth={1.75} />
                    <span className="truncate opacity-80" style={{ fontSize: cellFont(0.1) }}>{condition}</span>
                    {highLow && <span className="truncate opacity-70" style={{ fontSize: cellFont(0.095) }}>{highLow}</span>}
                </div>
            </div>
            {weather.hourly.length > 0 && (
                <div className="flex border-t pt-2" style={divider}>
                    {weather.hourly.map(hour => (
                        <HourColumn key={hour.hour} label={hourLabel(hour.hour)} code={hour.code} isDay={hour.isDay} temperature={hour.temperature} />
                    ))}
                </div>
            )}
            {weather.daily.length > 0 && (
                <div className="flex flex-col gap-1 border-t pt-2" style={divider}>
                    {weather.daily.map((day, index) => {
                        const DayIcon = describeWeatherCode(day.code, true).icon;
                        return (
                            <div key={day.date.getTime()} className="flex items-center gap-2" style={{ fontSize: cellFont(0.1) }}>
                                <span className="w-[3.2em] shrink-0 truncate">
                                    {index === 0 ? t('nightstand.weatherToday') : weekdayFormatter.format(day.date)}
                                </span>
                                <DayIcon className="shrink-0" style={{ width: cellLength(0.12), height: cellLength(0.12) }} strokeWidth={1.75} />
                                <span className="w-[2.2em] shrink-0 text-right tabular-nums opacity-60">{degrees(day.min)}</span>
                                <span
                                    className="relative h-1 min-w-0 flex-1 rounded-full"
                                    style={{ backgroundColor: 'color-mix(in srgb, var(--text-primary) 15%, transparent)' }}
                                >
                                    <span
                                        className="absolute inset-y-0 rounded-full"
                                        style={{
                                            left: `${((day.min - rangeMin) / span) * 100}%`,
                                            right: `${((rangeMax - day.max) / span) * 100}%`,
                                            backgroundColor: 'currentColor',
                                        }}
                                    />
                                </span>
                                <span className="w-[2.2em] shrink-0 tabular-nums">{degrees(day.max)}</span>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
};

export default memo(WeatherWidget);
