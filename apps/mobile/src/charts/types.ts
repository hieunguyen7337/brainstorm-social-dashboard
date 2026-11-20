/** Chart prop contracts. The charts unit implements these; screens only import from `@/src/charts`. */

export interface DonutDatum {
  key: string;
  label: string;
  value: number;
  color: string;
}

export interface DonutProps {
  data: DonutDatum[];
  /** Outer diameter in px. Default 200. */
  size?: number;
  /** Ring thickness in px. Default 26. */
  thickness?: number;
  /** Big text in the hole (e.g. "1.2M"). */
  centerValue?: string;
  /** Small text under it (e.g. "views"). */
  centerLabel?: string;
  /** Render the legend (swatch, label, value, share %) beside/below the ring. Default true. */
  legend?: boolean;
  /** Format a slice value for the legend. Default compact ("12.4k"). */
  formatValue?: (value: number) => string;
  /** Spoken name of the chart for screen readers, e.g. "Views by platform". Default derives from `centerLabel`. */
  title?: string;
}

export interface FunnelDatum {
  key: string;
  /** "Views", "Engagement", "Clicks", "Onboard". */
  label: string;
  value: number;
  /** Conversion from the previous stage, 0..1 (1 for the first stage). */
  rate: number;
}

export interface FunnelProps {
  data: FunnelDatum[];
  /** Total height in px. Default 260. */
  height?: number;
  /** Spoken name of the chart for screen readers. Default "Sales funnel". */
  title?: string;
}

export interface ChartSeries {
  key: string;
  label: string;
  color: string;
  /** One value per entry in `labels`. */
  values: number[];
}

export interface AreaChartProps {
  /** One label per x position (ISO dates "2026-11-20" for the dashboard). */
  labels: string[];
  series: ChartSeries[];
  /** Plot height in px (excluding axis labels). Default 180. */
  height?: number;
  /** Axis / tooltip number format. Default compact. */
  formatValue?: (value: number) => string;
  /** Axis / tooltip label format. Default `fmtDay`. */
  formatLabel?: (label: string) => string;
  /** Spoken name of the chart for screen readers, e.g. "Views, last 30 days". Default "Trend chart". */
  title?: string;
}

export interface SparklineProps {
  values: number[];
  color?: string;
  width?: number;
  height?: number;
  /** Fill under the line with a fading gradient. Default true. */
  fill?: boolean;
  /** Spoken name of the trend for screen readers, e.g. "Views trend". Default "Trend". */
  title?: string;
}
