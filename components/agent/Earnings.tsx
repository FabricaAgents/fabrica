import { usd } from '../../shared/format';

export function EarningsChart({ days }: { days: { day: string; calls: number; revenue: number }[] }) {
  const max = Math.max(1, ...days.map((d) => d.revenue));
  const w = 600;
  const h = 160;
  const bw = w / days.length;
  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${w} ${h + 24}`} role="img" aria-label="Revenue per day, last 30 days">
        {[0.5, 1].map((f) => (
          <line key={f} x1="0" x2={w} y1={h - h * f} y2={h - h * f} stroke="var(--line)" strokeDasharray="3 4" />
        ))}
        <line x1="0" x2={w} y1={h} y2={h} stroke="var(--line-2)" />
        {days.map((d, i) => {
          const bh = d.revenue ? Math.max(3, (d.revenue / max) * (h - 8)) : 0;
          return (
            <g key={d.day}>
              <rect x={i * bw + 2} y={h - bh} width={bw - 4} height={bh} rx="2" fill="var(--accent)">
                <title>{`${d.day}: ${d.calls} calls, ${usd(d.revenue)}`}</title>
              </rect>
            </g>
          );
        })}
        <text x="0" y={h + 18} fontSize="11" fill="var(--ink-3)" fontFamily="var(--font-mono)">
          {days[0]?.day.slice(5)}
        </text>
        <text x={w} y={h + 18} fontSize="11" fill="var(--ink-3)" textAnchor="end" fontFamily="var(--font-mono)">
          today
        </text>
      </svg>
      <figcaption>Revenue per day, last 30 days. Peak day {usd(max === 1 && !days.some((d) => d.revenue) ? 0 : max)}.</figcaption>
    </figure>
  );
}
