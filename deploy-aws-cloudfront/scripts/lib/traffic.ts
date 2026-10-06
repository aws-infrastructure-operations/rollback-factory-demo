/** Site-relative URLs a page loads (scripts, styles, icons): src="/..." and href="/..." attributes. */
export function pageResources(html: string): string[] {
  const urls = [...html.matchAll(/\b(?:src|href)="(\/[^"#?]*)/g)].map((m) => m[1]);
  return [...new Set(urls)].filter((url) => url !== '/');
}

/** Status-code tally, e.g. "200x12 403x30" (0 = network error). */
export class StatusCounter {
  private readonly counts = new Map<number, number>();

  add(status: number) {
    this.counts.set(status, (this.counts.get(status) ?? 0) + 1);
  }

  get total() {
    return [...this.counts.values()].reduce((a, b) => a + b, 0);
  }

  /** Share of 4xx responses, 0..1. */
  get rate4xx() {
    const errors = [...this.counts].filter(([s]) => s >= 400 && s < 500).reduce((a, [, n]) => a + n, 0);
    return this.total ? errors / this.total : 0;
  }

  toString() {
    return [...this.counts].sort(([a], [b]) => a - b).map(([s, n]) => `${s || 'network-error'}x${n}`).join(' ') || '(none)';
  }

  clear() {
    this.counts.clear();
  }
}
