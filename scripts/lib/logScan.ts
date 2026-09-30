/** Smallest span a failing chunk is bisected down to before the error is surfaced. */
const MIN_SPAN = 10_000n;
/** Chunks fetched at once: public RPCs rate-limit bursts. */
const CONCURRENCY = 4;

export interface ScanResult<T> {
  logs: T[];
  /** eth_getLogs requests made, including bisection retries. */
  calls: number;
}

type FetchRange<T> = (fromBlock: bigint, toBlock: bigint) => Promise<T[]>;

/** Splits [from, to] into consecutive inclusive ranges of at most `size` blocks. */
export function planChunks(from: bigint, to: bigint, size: bigint): Array<[bigint, bigint]> {
  if (size <= 0n) throw new Error("chunk size must be positive");
  const chunks: Array<[bigint, bigint]> = [];
  for (let start = from; start <= to; start += size) {
    const end = start + size - 1n;
    chunks.push([start, end < to ? end : to]);
  }
  return chunks;
}

/** Fetches one range; on failure (range too wide, too many results, timeout) retries both halves. */
async function fetchWithBisect<T>(fetchRange: FetchRange<T>, from: bigint, to: bigint): Promise<ScanResult<T>> {
  try {
    return { logs: await fetchRange(from, to), calls: 1 };
  } catch (err) {
    if (to - from < MIN_SPAN) throw err;
    const mid = from + (to - from) / 2n;
    const left = await fetchWithBisect(fetchRange, from, mid);
    const right = await fetchWithBisect(fetchRange, mid + 1n, to);
    return { logs: [...left.logs, ...right.logs], calls: 1 + left.calls + right.calls };
  }
}

/** Runs `task` over `items` with at most `limit` in flight, preserving order. */
async function mapLimit<I, O>(items: I[], limit: number, task: (item: I) => Promise<O>): Promise<O[]> {
  const results = new Array<O>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await task(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** eth_getLogs over [from, to] in `size`-block chunks, bisecting chunks the RPC rejects. Logs stay in block order. */
export async function getLogsChunked<T>(
  fetchRange: FetchRange<T>,
  from: bigint,
  to: bigint,
  size: bigint,
): Promise<ScanResult<T>> {
  const parts = await mapLimit(planChunks(from, to, size), CONCURRENCY, ([a, b]) => fetchWithBisect(fetchRange, a, b));
  return { logs: parts.flatMap((p) => p.logs), calls: parts.reduce((n, p) => n + p.calls, 0) };
}
