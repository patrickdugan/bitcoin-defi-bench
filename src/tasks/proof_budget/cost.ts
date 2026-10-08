// Family 7's prover cost model, read from a measurement of the R_cap program proven with Stwo
// (docs/tasks.md §8.5). Nothing here is modeled: seconds and peak memory come from the measured
// grid, linearly interpolated between grid points, and a batch larger than the largest measured
// one is not offered. A batch can always be padded with dummy claims to a larger measured size, so
// the seconds charged for b claims are the least over sizes from b up to the largest that fits.

export interface GridPoint { batch: number; seconds: number; peak_mib: number; steps: number; }

export interface CostTable {
  grid: GridPoint[];
  source: { file: string; sha256: string; program_sha256: string; toolchain: string; machine: string; statistic: string };
}

export class CostModel {
  readonly table: CostTable;
  readonly price: number;
  readonly ceilingMib: number;
  /** The largest batch whose interpolated peak memory, and every smaller batch's, fits under the ceiling. */
  readonly maxBatch: number;
  private readonly secs: Float64Array;

  constructor(table: CostTable, priceSatsPerSecond: number, ceilingMib: number) {
    const grid = [...table.grid].sort((a, b) => a.batch - b.batch);
    if (grid.length === 0 || grid[0]!.batch !== 1) throw new Error("the cost grid must start at a batch of one claim");
    this.table = table;
    this.price = priceSatsPerSecond;
    this.ceilingMib = ceilingMib;
    const top = grid[grid.length - 1]!.batch;
    let max = 0;
    for (let b = 1; b <= top; b++) { if (interp(grid, b, "peak_mib") > ceilingMib) break; max = b; }
    this.maxBatch = max;
    this.secs = new Float64Array(max + 2);
    let best = Number.POSITIVE_INFINITY;
    for (let b = max; b >= 1; b--) { best = Math.min(best, interp(grid, b, "seconds")); this.secs[b] = best; }
  }

  /** Prover seconds charged for a batch of b claims (padding allowed). */
  seconds(b: number): number {
    if (!Number.isInteger(b) || b < 1 || b > this.maxBatch) throw new Error(`no measured cost for a batch of ${b}`);
    return this.secs[b]!;
  }

  /** Prover cost in sats for a batch of b claims. */
  cost(b: number): number { return this.seconds(b) * this.price; }

  memory(b: number): number { return interp([...this.table.grid].sort((x, y) => x.batch - y.batch), b, "peak_mib"); }
}

function interp(grid: readonly GridPoint[], b: number, field: "seconds" | "peak_mib"): number {
  for (let i = 0; i < grid.length; i++) {
    const g = grid[i]!;
    if (g.batch === b) return g[field];
    if (g.batch > b) {
      const p = grid[i - 1]!;
      return p[field] + ((g[field] - p[field]) * (b - p.batch)) / (g.batch - p.batch);
    }
  }
  return Number.POSITIVE_INFINITY;
}
