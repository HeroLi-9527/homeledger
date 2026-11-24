import { esc, daysInMonth, pad } from './util.js';

const C = {
  grid: '#E2E8F0',
  axis: '#71717A',
  text: '#475569',
  textStrong: '#1E293B',
  income: '#0F766E',
  expense: '#BE123C',
  primary: '#0F766E',
};

function nf(n: number, d = 2): string {
  return Number(n || 0).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function niceMax(v: number): number {
  if (v <= 0) return 100;
  const exp = Math.floor(Math.log10(v));
  const base = Math.pow(10, exp);
  const m = v / base;
  const step = m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10;
  return step * base;
}

export interface ChartSeries {
  name: string;
  color: string;
  data: number[];
  dashed?: boolean;
}

export function barChart({
  labels = [],
  series = [],
  height = 240,
  showLegend = true,
  valueUnit = '',
}: {
  labels?: string[];
  series?: ChartSeries[];
  height?: number;
  showLegend?: boolean;
  valueUnit?: string;
} = {}): string {
  const W = 720;
  const H = height;
  const padL = 52;
  const padR = 16;
  const padT = showLegend ? 34 : 16;
  const padB = 30;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const allVals = series.flatMap((s) => s.data.map((v) => Math.abs(Number(v) || 0)));
  const max = niceMax(Math.max(...allVals, 0));
  const n = Math.max(labels.length, 1);
  const groupW = innerW / n;
  const barW = Math.min(18, (groupW * 0.62) / Math.max(series.length, 1));
  const gap = 4;

  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="xMidYMid meet" role="img" style="display:block">`;
  for (let i = 0; i <= 4; i++) {
    const y = padT + (innerH * i) / 4;
    const val = max - (max * i) / 4;
    s += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" stroke="${C.grid}" stroke-width="1"/>`;
    s += `<text x="${padL - 8}" y="${(y + 4).toFixed(1)}" font-size="11" fill="${C.axis}" text-anchor="end">${nf(val, 0)}</text>`;
  }
  labels.forEach((lab, i) => {
    const cx = padL + groupW * i + groupW / 2;
    const totalW = series.length * barW + (series.length - 1) * gap;
    let x0 = cx - totalW / 2;
    series.forEach((se) => {
      const v = Math.abs(Number(se.data[i]) || 0);
      const h = max > 0 ? (v / max) * innerH : 0;
      const y = padT + innerH - h;
      if (h > 0.5) {
        s += `<rect x="${x0.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="${se.color}"><title>${esc(se.name)} ${esc(lab)}：${nf(v)}${esc(valueUnit)}</title></rect>`;
      } else {
        s += `<rect x="${x0.toFixed(1)}" y="${(padT + innerH - 1.5).toFixed(1)}" width="${barW.toFixed(1)}" height="1.5" rx="0.75" fill="${se.color}" opacity="0.25"/>`;
      }
      x0 += barW + gap;
    });
    s += `<text x="${cx.toFixed(1)}" y="${H - 10}" font-size="11" fill="${C.axis}" text-anchor="middle">${esc(lab)}</text>`;
  });
  if (showLegend) {
    let lx = padL;
    series.forEach((se) => {
      s += `<rect x="${lx}" y="10" width="10" height="10" rx="2" fill="${se.color}"/>`;
      s += `<text x="${lx + 15}" y="19" font-size="12" fill="${C.text}">${esc(se.name)}</text>`;
      lx += 15 + se.name.length * 12 + 22;
    });
  }
  s += '</svg>';
  return s;
}

export function lineChart({
  labels = [],
  series = [],
  height = 220,
  showLegend = true,
  valueUnit = '',
}: {
  labels?: string[];
  series?: ChartSeries[];
  height?: number;
  showLegend?: boolean;
  valueUnit?: string;
} = {}): string {
  const W = 720;
  const H = height;
  const padL = 56;
  const padR = 20;
  const padT = showLegend ? 32 : 16;
  const padB = 30;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const vals = series.flatMap((se) => se.data.map((v) => Number(v) || 0));
  const rawMin = vals.length ? Math.min(0, ...vals) : 0;
  const rawMax = vals.length ? Math.max(0, ...vals) : 100;
  const span = rawMax - rawMin || 100;
  const minVal = rawMin < 0 ? -niceMax(Math.abs(rawMin)) : 0;
  const maxVal = rawMax > 0 ? niceMax(rawMax) : minVal + niceMax(span);
  const range = maxVal - minVal || 1;
  const yOf = (v: number) => padT + innerH - ((v - minVal) / range) * innerH;
  const count = labels.length;
  const xOf = (i: number) => (count <= 1 ? padL + innerW / 2 : padL + (innerW * i) / (count - 1));

  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="xMidYMid meet" role="img" style="display:block">`;
  for (let i = 0; i <= 4; i++) {
    const val = maxVal - (range * i) / 4;
    const y = padT + (innerH * i) / 4;
    s += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" stroke="${C.grid}" stroke-width="1"/>`;
    s += `<text x="${padL - 8}" y="${(y + 4).toFixed(1)}" font-size="11" fill="${C.axis}" text-anchor="end">${nf(val, 0)}</text>`;
  }
  if (minVal < 0 && maxVal > 0) {
    const y0 = yOf(0);
    s += `<line x1="${padL}" y1="${y0.toFixed(1)}" x2="${W - padR}" y2="${y0.toFixed(1)}" stroke="${C.axis}" stroke-dasharray="4 3" stroke-width="1"/>`;
  }

  series.forEach((se, sIdx) => {
    const pts = labels.map((_, i) => ({ x: xOf(i), y: yOf(Number(se.data[i]) || 0), v: Number(se.data[i]) || 0 }));
    if (pts.length) {
      const poly = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
      if (sIdx === 0 && pts.length > 1) {
        const baseY = yOf(Math.max(minVal, Math.min(0, maxVal))).toFixed(1);
        const area = `${pts[0].x.toFixed(1)},${baseY} ${poly} ${pts[pts.length - 1].x.toFixed(1)},${baseY}`;
        s += `<polygon points="${area}" fill="${se.color}" opacity="0.10"/>`;
      }
      s += `<polyline fill="none" stroke="${se.color}" stroke-width="2.4"${se.dashed ? ' stroke-dasharray="5 4"' : ''} stroke-linecap="round" stroke-linejoin="round" points="${poly}"/>`;
      pts.forEach((p, i) => {
        s += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.5" fill="#ffffff" stroke="${se.color}" stroke-width="2"><title>${esc(se.name)} ${esc(labels[i])}：${nf(p.v)}${esc(valueUnit)}</title></circle>`;
      });
    }
  });

  const labelStep = count > 16 ? Math.ceil(count / 15) : 1;
  labels.forEach((lab, i) => {
    if (labelStep > 1 && i % labelStep !== 0 && i !== count - 1) return;
    s += `<text x="${xOf(i).toFixed(1)}" y="${H - 10}" font-size="11" fill="${C.axis}" text-anchor="middle">${esc(lab)}</text>`;
  });
  if (showLegend) {
    let lx = padL;
    series.forEach((se) => {
      s += `<line x1="${lx}" y1="15" x2="${lx + 14}" y2="15" stroke="${se.color}" stroke-width="2.5"/>`;
      s += `<text x="${lx + 18}" y="19" font-size="12" fill="${C.text}">${esc(se.name)}</text>`;
      lx += 18 + se.name.length * 12 + 22;
    });
  }
  s += '</svg>';
  return s;
}

export interface DonutItem {
  name: string;
  value: number;
  color: string;
}

export function donutChart(
  items: DonutItem[] = [],
  {
    size = 200,
    thickness = 26,
    centerTitle = '',
    centerValue = '',
    valueUnit = '',
  }: { size?: number; thickness?: number; centerTitle?: string; centerValue?: string; valueUnit?: string } = {},
): string {
  const total = items.reduce((a, b) => a + Math.abs(Number(b.value) || 0), 0);
  const r = size / 2 - thickness / 2 - 2;
  const cx = size / 2;
  const cy = size / 2;
  const circ = 2 * Math.PI * r;
  let offset = 0;
  let s = `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" style="display:block">`;
  if (total <= 0) {
    s += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${C.grid}" stroke-width="${thickness}"/>`;
  } else {
    items.forEach((it) => {
      const v = Math.abs(Number(it.value) || 0);
      if (v <= 0) return;
      const len = (v / total) * circ;
      if (len < 2) {
        offset += len;
        return;
      }
      s += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${it.color}" stroke-width="${thickness}" stroke-dasharray="${Math.max(len - 2, 0).toFixed(2)} ${(circ - len + 2).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})" stroke-linecap="butt"><title>${esc(it.name)}：${nf(v)}${esc(valueUnit)}（${((v / total) * 100).toFixed(1)}%）</title></circle>`;
      offset += len;
    });
  }
  if (centerValue) {
    s += `<text x="${cx}" y="${cy - 2}" font-size="16" font-weight="700" fill="${C.textStrong}" text-anchor="middle">${esc(centerValue)}</text>`;
  }
  if (centerTitle) {
    s += `<text x="${cx}" y="${cy + 16}" font-size="11" fill="${C.axis}" text-anchor="middle">${esc(centerTitle)}</text>`;
  }
  s += '</svg>';
  return s;
}

export function donutLegend(items: DonutItem[] = [], total: number | null = null, valueUnit = ''): string {
  const sum = total === null ? items.reduce((a, b) => a + Math.abs(Number(b.value) || 0), 0) : total;
  return items
    .map((it) => {
      const v = Math.abs(Number(it.value) || 0);
      const p = sum ? ((v / sum) * 100).toFixed(1) : '0.0';
      return `<div class="legend-row">
        <span class="legend-dot" style="background:${it.color}"></span>
        <span class="legend-name">${esc(it.name)}</span>
        <span class="legend-bar"><i style="width:${p}%;background:${it.color}"></i></span>
        <span class="legend-pct">${p}%</span>
        <span class="legend-val">${nf(v)}${esc(valueUnit)}</span>
      </div>`;
    })
    .join('');
}

export interface HeatmapDay {
  date: string;
  income: number;
  expense: number;
  count: number;
}

export function heatmapChart({
  month,
  days = [],
  valueUnit = '元',
}: {
  month: string;
  days?: HeatmapDay[];
  valueUnit?: string;
}): string {
  const totalDays = daysInMonth(month);
  const firstWd = new Date(`${month}-01T00:00:00Z`).getUTCDay();
  const mondayFirstOffset = (firstWd + 6) % 7;
  const rows = Math.ceil((mondayFirstOffset + totalDays) / 7);
  const map = new Map(days.map((d) => [d.date, d]));
  const maxExp = Math.max(1, ...days.map((d) => Number(d.expense) || 0));

  const cellW = 48;
  const cellH = 38;
  const gap = 6;
  const padX = 12;
  const padTop = 26;
  const W = padX * 2 + 7 * cellW + 6 * gap;
  const H = padTop + rows * cellH + (rows - 1) * gap + 12;
  const headers = ['一', '二', '三', '四', '五', '六', '日'];
  const fills = ['#F1F5F9', '#CCFBF1', '#5EEAD4', '#0F766E', '#BE123C'];

  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="xMidYMid meet" role="img" style="display:block">`;
  headers.forEach((h, i) => {
    const x = padX + i * (cellW + gap) + cellW / 2;
    s += `<text x="${x}" y="16" font-size="11" fill="${C.axis}" text-anchor="middle">${h}</text>`;
  });

  for (let day = 1; day <= totalDays; day++) {
    const idx = mondayFirstOffset + (day - 1);
    const col = idx % 7;
    const row = Math.floor(idx / 7);
    const x = padX + col * (cellW + gap);
    const y = padTop + row * (cellH + gap);
    const dateStr = `${month}-${pad(day)}`;
    const d = map.get(dateStr);
    const exp = Number(d?.expense || 0);
    const inc = Number(d?.income || 0);
    const ratio = exp > 0 ? exp / maxExp : 0;
    const level = exp <= 0 ? 0 : ratio < 0.25 ? 1 : ratio < 0.5 ? 2 : ratio < 0.8 ? 3 : 4;
    const textFill = level >= 3 ? '#ffffff' : C.textStrong;
    s += `<g><rect x="${x}" y="${y}" width="${cellW}" height="${cellH}" rx="6" fill="${fills[level]}" stroke="#e5e7eb" stroke-width="1"/>`;
    s += `<text x="${x + 6}" y="${y + 15}" font-size="11" font-weight="600" fill="${textFill}">${day}</text>`;
    if (exp > 0) {
      s += `<text x="${x + cellW - 5}" y="${y + cellH - 7}" font-size="9.5" fill="${textFill}" text-anchor="end">-${nf(exp / 100, 0)}</text>`;
    } else if (inc > 0) {
      s += `<text x="${x + cellW - 5}" y="${y + cellH - 7}" font-size="9.5" fill="${C.income}" text-anchor="end">+${nf(inc / 100, 0)}</text>`;
    }
    s += `<title>${dateStr}：支出 ${nf(exp / 100)}${esc(valueUnit)}，收入 ${nf(inc / 100)}${esc(valueUnit)}（${d?.count || 0} 笔）</title></g>`;
  }
  s += '</svg>';
  return s;
}

export function progressBar(
  used: number,
  total: number,
  { color = C.primary, height = 8, warn = false }: { color?: string; height?: number; warn?: boolean } = {},
): string {
  const p = total > 0 ? Math.min((used / total) * 100, 100) : 0;
  const over = used > total;
  const c = over || warn ? '#BE123C' : p > 80 ? '#D97706' : color;
  return `<div class="progress" style="height:${height}px"><i style="width:${p.toFixed(1)}%;background:${c}"></i></div>`;
}
