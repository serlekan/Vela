import type { OHLCV } from '../../../core/model/ohlcv';
import type { BarRange, SymbolInfo } from '../../../core/ports/MarketDataFeed';
import type { DataProvider, ProviderInfo, SymbolDescriptor } from '../../../core/ports/DataProvider';
import { baseOf, ledgerCryptoIconUrl } from '../../symbol-base';

const BASE_URL = 'https://api-contract.weex.com/capi/v2/market';
/** The history endpoint answers at most this many candles per call. */
const PAGE = 100;
/** Windows fetched in parallel while walking a range. */
const CONCURRENCY = 4;
/**
 * Consecutive empty windows that end a backward walk. WEEX answers an empty window
 * for time before a contract listed, so a walk past genesis stops instead of
 * paging back to the epoch; two in a row tolerate a single quiet window.
 */
const EMPTY_WINDOWS_TO_STOP = 2;
/** Pause before the single retry of a failed page. */
const RETRY_MS = 400;

/** One raw WEEX candle: `[openTime, open, high, low, close, baseVolume, quoteVolume]`, all strings. */
type RawCandle = ReadonlyArray<string | number>;

/** Canonical timeframe → WEEX granularity (native, no aggregation). */
const TF_TO_GRANULARITY: Record<string, string> = {
    '1': '1m',
    '5': '5m',
    '15': '15m',
    '30': '30m',
    '60': '1h',
    '240': '4h',
    '720': '12h',
    D: '1d',
    W: '1w',
};

/** User-facing timeframe aliases → canonical keys (matches the other Vela layers). */
const TF_NORMALIZE: Record<string, string> = {
    '1m': '1',
    '3m': '3',
    '5m': '5',
    '15m': '15',
    '30m': '30',
    '45m': '45',
    '1h': '60',
    '2h': '120',
    '3h': '180',
    '4h': '240',
    '6h': '360',
    '8h': '480',
    '12h': '720',
    '1d': 'D',
    '1w': 'W',
    '1D': 'D',
    '1W': 'W',
    '4H': '240',
    D: 'D',
    W: 'W',
};

/** Native intraday timeframes WEEX serves (minutes) — aggregation sub-candidates. */
const NATIVE_MINUTES = [1, 5, 15, 30, 60, 240, 720];
const MIN_TO_GRANULARITY: Record<number, string> = { 1: '1m', 5: '5m', 15: '15m', 30: '30m', 60: '1h', 240: '4h', 720: '12h' };
const SUPPORTED_TIMEFRAMES = ['1', '3', '5', '15', '30', '45', '60', '120', '180', '240', '360', '480', '720', 'D', 'W'];

const TF_MS: Record<string, number> = { D: 86_400_000, W: 604_800_000 };
function tfMs(tf: string): number {
    if (TF_MS[tf]) return TF_MS[tf];
    const min = parseInt(tf, 10);
    return Number.isFinite(min) && min > 0 ? min * 60_000 : 3_600_000;
}

/** Normalize a user timeframe to a canonical key. */
export function normalizeTf(tf: string): string {
    return TF_NORMALIZE[tf] ?? TF_NORMALIZE[tf.toLowerCase()] ?? tf;
}

/**
 * Map a Vela ticker to a WEEX contract id: `BTCUSDT.P` (or `BTCUSDT`) → `cmt_btcusdt`.
 * WEEX lists perpetual contracts only, so the `.P` suffix is accepted but optional.
 */
export function parseContract(ticker: string): string {
    const t = ticker.trim().replace(/\.P$/i, '');
    return `cmt_${t.toLowerCase()}`;
}

/**
 * Map raw candles to neutral OHLCV. WEEX pads the time before a contract listed with
 * all-zero candles; those are dropped so a chart never draws a flat line at 0.
 */
export function candlesToOHLCV(raw: RawCandle[]): OHLCV[] {
    const out: OHLCV[] = [];
    for (const k of raw) {
        const close = Number(k[4]);
        if (!(close > 0)) continue;
        out.push({ time: Number(k[0]), open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close, volume: Number(k[5]) });
    }
    return out;
}

/** Sort by open-time and drop duplicate open-times (incoming wins) — the bar contract. */
export function dedupeSorted(bars: OHLCV[]): OHLCV[] {
    const byTime = new Map<number, OHLCV>();
    for (const b of bars) byTime.set(b.time, b);
    return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/** Aggregate ascending sub-candles into `bucketMs` buckets aligned to the epoch. */
export function aggregate(sub: OHLCV[], bucketMs: number): OHLCV[] {
    const buckets = new Map<number, OHLCV>();
    for (const b of sub) {
        const key = Math.floor(b.time / bucketMs) * bucketMs;
        const cur = buckets.get(key);
        if (!cur) {
            buckets.set(key, { time: key, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 });
        } else {
            cur.high = Math.max(cur.high, b.high);
            cur.low = Math.min(cur.low, b.low);
            cur.close = b.close;
            cur.volume = (cur.volume ?? 0) + (b.volume ?? 0);
        }
    }
    return [...buckets.values()].sort((a, b) => a.time - b.time);
}

/** Largest native sub-timeframe (minutes) that evenly divides `targetMin`, or null. */
function selectSubTf(targetMin: number): number | null {
    return NATIVE_MINUTES.filter((m) => m < targetMin && targetMin % m === 0).sort((a, b) => b - a)[0] ?? null;
}

/**
 * Split `[start, end)` into page-sized windows, newest first — the order a backward
 * walk consumes them so it can stop at genesis.
 */
export function windowsNewestFirst(start: number, end: number, intervalMs: number): Array<[number, number]> {
    const span = PAGE * intervalMs;
    const out: Array<[number, number]> = [];
    for (let e = end; e > start; e -= span) out.push([Math.max(start, e - span), e]);
    return out;
}

/**
 * WEEX market-data provider, built from scratch on the public contract API — no
 * third-party SDK, no API key. Serves USDT-margined perpetual contracts (`BTCUSDT.P`,
 * `SOLUSDT.P`, …), paginates past the 100-candle page size, and aggregates timeframes
 * WEEX doesn't serve natively (e.g. `3`, `45`, `120`). WEEX answers browser requests
 * with an open CORS policy, so no proxy is needed. Live ticks come from the feed's
 * standard polling (there is no `subscribe`).
 *
 *   import { WeexProvider } from 'vela/providers/weex';
 *   chart.data.registerProvider('weex', new WeexProvider());
 */
export class WeexProvider implements DataProvider {
    /** Cached contract list (fetched once; drives symbols and syminfo). */
    private contractsPromise: Promise<WeexContract[]> | null = null;

    info(): ProviderInfo {
        return {
            name: 'weex',
            displayName: 'WEEX',
            requiresApiKey: false,
            supportedTimeframes: SUPPORTED_TIMEFRAMES,
            capabilities: { enumerate: true, stream: false, symbolInfo: true },
        };
    }

    async getBars(ticker: string, timeframe: string, range: BarRange): Promise<OHLCV[]> {
        try {
            const contract = parseContract(ticker);
            const tf = normalizeTf(timeframe);

            const granularity = TF_TO_GRANULARITY[tf];
            if (granularity) return await this.fetchCandles(contract, granularity, tfMs(tf), range);

            // Aggregation path: fetch a native sub-timeframe and combine.
            const targetMin = /^\d+$/.test(tf) ? parseInt(tf, 10) : null;
            const subMin = targetMin != null ? selectSubTf(targetMin) : null;
            if (targetMin == null || subMin == null) {
                console.warn(`[vela] WEEX: timeframe "${timeframe}" is not supported and cannot be aggregated.`);
                return [];
            }
            const ratio = targetMin / subMin;
            const subRange: BarRange = { ...range, limit: range.limit != null ? range.limit * ratio + ratio : undefined };
            const sub = await this.fetchCandles(contract, MIN_TO_GRANULARITY[subMin]!, subMin * 60_000, subRange);
            const agg = aggregate(sub, targetMin * 60_000);
            return range.limit != null && range.from == null && agg.length > range.limit ? agg.slice(-range.limit) : agg;
        } catch (e) {
            // Fail soft (consistent with the other providers): an empty result parks/empties
            // the chart with a warning rather than rejecting the parked load.
            console.warn(`[vela] WEEX: failed to fetch ${ticker} ${timeframe} — ${e instanceof Error ? e.message : String(e)}`);
            return [];
        }
    }

    async getSymbolInfo(ticker: string): Promise<SymbolInfo | undefined> {
        const id = parseContract(ticker);
        const c = (await this.fetchContracts().catch(() => [] as WeexContract[])).find((x) => x.symbol === id);
        if (!c) return undefined;
        // `tick_size` is the number of price decimals (BTC "1" → 0.1, SOL "2" → 0.01).
        const decimals = parseInt(String(c.tick_size), 10);
        const mintick = Math.pow(10, -(Number.isFinite(decimals) ? decimals : 2));
        const display = displayTicker(c);
        return {
            ticker: display,
            tickerid: `WEEX:${display}`,
            prefix: 'WEEX',
            description: `${c.underlying_index} / ${c.quote_currency} Perpetual`,
            type: 'futures',
            basecurrency: c.underlying_index,
            currency: c.quote_currency,
            mintick,
            pricescale: Math.round(1 / mintick),
            timezone: 'Etc/UTC',
            session: '24x7',
        };
    }

    async listSymbols(): Promise<SymbolDescriptor[]> {
        const contracts = await this.fetchContracts().catch(() => [] as WeexContract[]);
        return contracts
            .filter((c) => c.symbol?.startsWith('cmt_') && c.underlying_index && c.quote_currency)
            .map((c) => ({ ticker: displayTicker(c), description: `${c.underlying_index} / ${c.quote_currency} Perpetual`, type: 'futures' }));
    }

    /** Predefined icon source for a crypto venue: the Ledger crypto-icon CDN, keyed by the BASE asset. */
    resolveSymbolIcon(symbol: SymbolDescriptor): string | undefined {
        return ledgerCryptoIconUrl(baseOf(symbol));
    }

    // ── internals ────────────────────────────────────────────────────────

    /**
     * Fetch candles for a time window. The history endpoint takes a `[startTime, endTime]`
     * window and caps each answer at 100 candles, so a range is split into page windows
     * and walked newest-first, a few in parallel. A bar `limit` without `from` becomes a
     * start offset; a `from` range (the cache's tail refresh) is used directly. The newest
     * candle is the forming one.
     */
    private async fetchCandles(contract: string, granularity: string, intervalMs: number, range: BarRange): Promise<OHLCV[]> {
        const now = Date.now();
        // One interval past `to` so the window includes the candle that opens at `to`.
        const end = Math.min(range.to ?? now, now) + intervalMs;
        const start = range.from != null ? range.from : end - ((range.limit ?? 500) + 1) * intervalMs;
        const windows = windowsNewestFirst(start, end, intervalMs);

        const collected: OHLCV[] = [];
        let empty = 0;
        for (let i = 0; i < windows.length && empty < EMPTY_WINDOWS_TO_STOP; i += CONCURRENCY) {
            const batch = windows.slice(i, i + CONCURRENCY);
            const pages = await Promise.all(batch.map(([s, e]) => this.history(contract, granularity, s, e)));
            for (const page of pages) {
                empty = page.length === 0 ? empty + 1 : 0;
                for (const b of page) if (b.time >= start && b.time < end) collected.push(b);
                if (empty >= EMPTY_WINDOWS_TO_STOP) break;
            }
        }
        const bars = dedupeSorted(collected);
        // Count-bounded (no explicit `from`): keep the most-recent `limit` bars.
        if (range.from == null && range.limit != null && bars.length > range.limit) return bars.slice(-range.limit);
        return bars;
    }

    private async history(contract: string, granularity: string, startTime: number, endTime: number): Promise<OHLCV[]> {
        const qs = new URLSearchParams({
            symbol: contract,
            granularity,
            startTime: String(Math.floor(startTime)),
            endTime: String(Math.floor(endTime)),
            limit: String(PAGE),
        });
        const url = `${BASE_URL}/historyCandles?${qs.toString()}`;
        // One retry after a short pause: a deep load fires many pages, and a single
        // throttled page would otherwise empty the whole answer.
        const data = await this.json(url).catch(() => new Promise((r) => setTimeout(r, RETRY_MS)).then(() => this.json(url)));
        const rows = Array.isArray(data) ? data : ((data as { data?: unknown })?.data ?? []);
        return Array.isArray(rows) ? candlesToOHLCV(rows as RawCandle[]) : [];
    }

    private fetchContracts(): Promise<WeexContract[]> {
        return (this.contractsPromise ??= this.json(`${BASE_URL}/contracts`)
            .then((d) => {
                const rows = Array.isArray(d) ? d : ((d as { data?: unknown })?.data ?? []);
                return Array.isArray(rows) ? (rows as WeexContract[]) : [];
            })
            .catch((e) => {
                this.contractsPromise = null; // a failed listing is retried on the next call, never cached
                throw e;
            }));
    }

    private async json(url: string): Promise<unknown> {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`WEEX HTTP ${res.status}`);
        return res.json();
    }
}

/** `BTC` + `USDT` → `BTCUSDT.P` — the ticker users type and Pine reads. */
function displayTicker(c: WeexContract): string {
    return `${c.underlying_index}${c.quote_currency}.P`.toUpperCase();
}

/** The subset of a WEEX `/contracts` row this provider reads. */
interface WeexContract {
    symbol: string; // cmt_btcusdt
    underlying_index: string; // BTC
    quote_currency: string; // USDT
    tick_size: string | number; // price decimals
}
