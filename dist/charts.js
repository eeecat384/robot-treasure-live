// Browser-only telemetry charts. Time arguments use milliseconds; no values are
// predicted, resampled, or held after the last received sample.
import { WHEEL_POSITIONS } from './wheel-layout.js';
const TARGET = '#267969';
const ACTUAL = '#e8884c';
const LASER = '#267969';
const MAX_SAMPLES = 12000;
const GAP_MS = 1000;
const WHEEL_NAMES = ['A', 'B', 'C', 'D'];
const LASER_NAMES = ['前', '左', '后', '右'];
const LASER_KEYS = ['F', 'L', 'B', 'R'];

function installStyles() {
  if (document.getElementById('waveform-styles')) return;
  const style = document.createElement('style');
  style.id = 'waveform-styles';
  style.textContent = `
    .waveform-panel{min-width:0;color:#173e38;background:#fff;border:1px solid #e3e9e4;border-radius:10px;padding:16px;margin-top:18px;overflow:hidden}
    .wf-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px}
    .wf-heading h2{font-size:13px;font-weight:600;margin:0}.wf-heading small{display:block;margin-top:4px;font-size:9px;color:#82958a;font-weight:400}
    .wf-options{display:flex;gap:7px;align-items:center}.wf-options select{width:auto;max-width:150px;font-size:10px;padding:6px;border:1px solid #e3e9e4;border-radius:5px;background:#f5f7f3;color:#173e38}
    .wf-group+.wf-group{margin-top:15px;padding-top:14px;border-top:1px solid #e8eee7}
    .wf-group-heading{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:9px}.wf-group-title{font-size:11px;font-weight:600}.wf-toggles{display:flex;gap:10px;align-items:center}.wf-toggles label{display:flex;align-items:center;gap:4px;cursor:pointer;font-size:10px;color:#738b7b}.wf-toggles input{width:12px;height:12px;margin:0;accent-color:#267969}
    .wf-legend{display:flex;gap:12px;align-items:center;font-size:9px;color:#82958a;margin-bottom:8px;flex-wrap:wrap}.wf-legend span{display:inline-flex;align-items:center;gap:5px}.wf-legend i{width:14px;height:2px;display:inline-block}.wf-legend .wf-target{background:#267969}.wf-legend .wf-actual{background:#e8884c}.wf-legend em{font-style:normal;margin-left:auto;font-size:9px}
    .wf-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.wf-card{min-width:0;background:#fbfcfa;border:1px solid #e7ede5;border-radius:6px;overflow:hidden}.wf-card[hidden]{display:none}.wf-card-heading{padding:9px 10px 0;display:flex;justify-content:space-between;align-items:baseline;gap:5px;min-height:24px}.wf-card-heading strong{font-size:10px;font-weight:600;white-space:nowrap}.wf-value{font:9px 'IBM Plex Mono','Consolas',monospace;color:#6e8777;text-align:right;white-space:nowrap}.wf-value.stale{color:#a0aca3}.wf-card-status{display:block;padding:2px 10px 0;font-size:8px;color:#8c9c91;min-height:14px}.wf-card-status.stale{color:#b88a66}.wf-card canvas{display:block;width:100%;height:120px}.wf-empty{font-size:10px;color:#8b9c90;text-align:center;padding:17px 0;background:#f5f7f3;border-radius:5px;grid-column:1/-1}.wf-empty[hidden]{display:none}.wf-note{font-size:9px;line-height:1.7;color:#8c9c91;margin:11px 0 0}
    .charts-right .waveform-panel,.waveform-panel.charts-right{margin-top:0;padding:13px;grid-column:1/-1}.charts-right .wf-grid,.waveform-panel.charts-right .wf-grid{grid-template-columns:minmax(0,1fr)}.charts-right .wf-card canvas,.waveform-panel.charts-right .wf-card canvas{height:104px}.charts-right .wf-heading,.waveform-panel.charts-right .wf-heading{gap:9px}.charts-right .wf-options,.waveform-panel.charts-right .wf-options{width:100%}.charts-right .wf-options select,.waveform-panel.charts-right .wf-options select{min-width:0;flex:1;max-width:none}.charts-right .wf-legend em,.waveform-panel.charts-right .wf-legend em{margin-left:0}
    @media(max-width:600px){.waveform-panel{padding:12px}.wf-grid{grid-template-columns:minmax(0,1fr)}.wf-options{width:100%}.wf-options select{flex:1;max-width:none}.wf-legend em{margin-left:0}}
  `;
  document.head.append(style);
}

class SampleBuffer {
  constructor() { this.rows = []; this.start = 0; }
  push(row) {
    const last = this.rows.at(-1);
    if (last && row.time < last.time) return;
    this.rows.push(row);
    if (this.rows.length - this.start > MAX_SAMPLES) this.start++;
    if (this.start > 2048) {
      this.rows = this.rows.slice(this.start);
      this.start = 0;
    }
  }
  lowerBound(time) {
    let low = this.start, high = this.rows.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.rows[middle].time < time) low = middle + 1;
      else high = middle;
    }
    return low;
  }
  clear() { this.rows.length = 0; this.start = 0; }
}

function valueText(value) {
  if (!Number.isFinite(value)) return '—';
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function axisText(value) {
  const absolute = Math.abs(value);
  if (absolute >= 10000) return `${(value / 1000).toFixed(0)}k`;
  if (absolute >= 1000) return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (absolute >= 10) return String(Math.round(value));
  return value.toFixed(1).replace(/\.0$/, '');
}

function finite(value) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }

export class WaveformPanel {
  constructor(container, { kind = 'all' } = {}) {
    if (!(container instanceof Element)) throw new TypeError('WaveformPanel requires a container element');
    installStyles();
    this.container = container;
    this.container.classList.add('waveform-panel');
    this.windowMs = 30000;
    this.latestTime = 0;
    this.now = 0;
    this.dirty = true;
    this.destroyed = false;
    this.lastPaint = -Infinity;
    this.cards = [];
    this.groups = [];
    this.kind = kind;
    this.container.innerHTML = `
      <div class="wf-heading"><div><h2>${kind === 'wheel' ? '轮速波形' : kind === 'laser' ? '激光波形' : '实时波形'} <small>按收到的样本绘制</small></h2></div><div class="wf-options"><select class="wf-window" aria-label="${kind === 'wheel' ? '轮速' : kind === 'laser' ? '激光' : '波形'}时间范围"><option value="10000">最近 10 秒</option><option value="30000" selected>最近 30 秒</option><option value="60000">最近 60 秒</option></select><select class="wf-placement" aria-label="${kind === 'wheel' ? '轮速' : kind === 'laser' ? '激光' : '波形'}显示位置"><option value="left">左侧栏</option><option value="middle">地图与串口之间</option><option value="right" selected>右侧栏</option></select></div></div>
      ${kind !== 'laser' ? '<section class="wf-group" aria-label="四轮目标与实际轮速"><div class="wf-group-heading"><span class="wf-group-title">四轮轮速</span><div class="wf-toggles wf-wheel-toggles"></div></div><div class="wf-legend"><span><i class="wf-target"></i>目标</span><span><i class="wf-actual"></i>实际</span><em>mm/s · 上排 A / B，下排 C / D</em></div><div class="wf-grid wf-wheel-grid"></div></section>' : ''}
      ${kind !== 'wheel' ? '<section class="wf-group" aria-label="四向激光距离"><div class="wf-group-heading"><span class="wf-group-title">四向激光</span><div class="wf-toggles wf-laser-toggles"></div></div><div class="wf-legend"><span><i class="wf-target"></i>检测距离</span><em>mm · 0 / 无效值显示为空缺</em></div><div class="wf-grid wf-laser-grid"></div></section>' : ''}
      <p class="wf-note">${kind !== 'laser' ? '单轮速度仅显示 WF / W4 实际样本；空白表示固件未输出。' : ''}横轴为时间（秒），超过 1 秒未收到样本会断线。回放与实时观测使用相同数据。</p>`;
    this.windowSelect = container.querySelector('.wf-window');
    this.placementSelect = container.querySelector('.wf-placement');
    this.onChange = event => {
      if (event.target === this.windowSelect) {
        this.windowMs = Number(this.windowSelect.value);
        this.dirty = true;
        this.render(this.now);
      } else if (event.target === this.placementSelect) {
        this.setPlacement(this.placementSelect.value);
        container.dispatchEvent(new CustomEvent('chart-placement', {
          bubbles: true, detail: { kind: this.kind, placement: this.placementSelect.value }
        }));
      }
    };
    container.addEventListener('change', this.onChange);
    if (kind !== 'laser') this.makeGroup('wheel', WHEEL_NAMES, WHEEL_NAMES.map(name => `${name} 轮 · ${WHEEL_POSITIONS[name]}`));
    if (kind !== 'wheel') this.makeGroup('laser', LASER_KEYS, LASER_NAMES.map((name, i) => `${name}激光 · ${LASER_KEYS[i]}`));
    this.wheelCards = this.cards.filter(card => card.kind === 'wheel');
    this.laserCards = this.cards.filter(card => card.kind === 'laser');
    this.resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
      this.dirty = true;
      this.render(this.now);
    }) : null;
    this.resizeObserver?.observe(container);
    this.onResize = () => { this.dirty = true; this.render(this.now); };
    window.addEventListener('resize', this.onResize);
    this.setPlacement('right');
    this.render(0);
  }

  makeGroup(kind, keys, labels) {
    const grid = this.container.querySelector(`.wf-${kind}-grid`);
    const toggles = this.container.querySelector(`.wf-${kind}-toggles`);
    const group = { cards: [], grid, empty: document.createElement('div') };
    keys.forEach((key, index) => {
      const label = document.createElement('label');
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = true;
      toggle.setAttribute('aria-label', `显示${labels[index]}波形`);
      label.append(toggle, document.createTextNode(kind === 'laser' ? `${LASER_NAMES[index]} ${key}` : key));
      toggles.append(label);
      const element = document.createElement('div');
      element.className = 'wf-card';
      const header = document.createElement('div');
      header.className = 'wf-card-heading';
      const title = document.createElement('strong');
      title.textContent = labels[index];
      const readout = document.createElement('span');
      readout.className = 'wf-value';
      readout.textContent = kind === 'wheel' ? '目标 — / 实际 —' : '— mm';
      const canvas = document.createElement('canvas');
      const status = document.createElement('small');
      status.className = 'wf-card-status';
      status.textContent = kind === 'wheel' ? '等待 WF / W4 样本' : '等待激光样本';
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', `${labels[index]}时间波形，等待样本`);
      header.append(title, readout);
      element.append(header, status, canvas);
      grid.append(element);
      const card = { kind, index, key, canvas, context: canvas.getContext('2d'), element, readout, status, toggle, samples: new SampleBuffer() };
      toggle.addEventListener('change', () => {
        element.hidden = !toggle.checked;
        group.empty.hidden = group.cards.some(item => item.toggle.checked);
        this.dirty = true;
        this.render(this.now);
      });
      this.cards.push(card);
      group.cards.push(card);
    });
    group.empty.className = 'wf-empty';
    group.empty.textContent = '在上方勾选要查看的通道';
    group.empty.hidden = true;
    grid.append(group.empty);
    this.groups.push(group);
  }

  ingestWheel(time, wheels) {
    if (!Number.isFinite(time) || !Array.isArray(wheels) || this.destroyed) return;
    this.latestTime = Math.max(this.latestTime, time);
    for (let i = 0; i < this.wheelCards.length; i++) {
      const wheel = wheels[i];
      if (!wheel || typeof wheel !== 'object') continue;
      this.wheelCards[i].samples.push({ time, target: finite(wheel?.target), actual: finite(wheel?.actual), pwm: finite(wheel?.pwm) });
    }
    this.dirty = true;
  }

  ingestLaser(time, ranges) {
    if (!Number.isFinite(time) || !Array.isArray(ranges) || this.destroyed) return;
    this.latestTime = Math.max(this.latestTime, time);
    for (let i = 0; i < this.laserCards.length; i++) {
      const distance = finite(ranges[i]);
      this.laserCards[i].samples.push({ time, distance: distance !== null && distance > 0 ? distance : null });
    }
    this.dirty = true;
  }

  setPlacement(placement) {
    if (this.destroyed) return;
    const value = ['left', 'middle', 'right'].includes(placement) ? placement : 'right';
    this.placementSelect.value = value;
    this.container.classList.toggle('charts-right', value === 'right');
    this.container.classList.toggle('charts-left', value === 'left');
    this.dirty = true;
    this.render(this.now);
  }

  reset() {
    for (const card of this.cards) card.samples.clear();
    this.latestTime = 0;
    this.now = 0;
    this.dirty = true;
    this.render(0);
  }

  render(now = this.latestTime) {
    if (this.destroyed) return;
    const end = Number.isFinite(now) ? now : this.latestTime;
    const repaintTime = performance.now();
    // Keep the idle scrolling clock to ten paints per second. New samples and
    // explicit resets/resizes redraw immediately without dropping data.
    if (!this.dirty && end === this.now) return;
    if (!this.dirty && repaintTime - this.lastPaint < 100) return;
    this.now = end;
    this.lastPaint = repaintTime;
    this.dirty = false;
    for (const card of this.cards) if (card.toggle.checked) this.paintCard(card, end);
  }

  paintCard(card, end) {
    const { canvas, context: ctx, samples } = card;
    if (!ctx) return;
    const bounds = canvas.getBoundingClientRect();
    const width = Math.round(bounds.width);
    const height = Math.round(bounds.height);
    if (width < 20 || height < 20) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const pixelWidth = Math.round(width * dpr), pixelHeight = Math.round(height * dpr);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const left = Math.min(43, Math.max(33, width * .16));
    const top = 12, right = width - 10, bottom = height - 23;
    const start = end - this.windowMs;
    const from = samples.lowerBound(start);
    const until = samples.lowerBound(end + .0001);
    const keys = card.kind === 'wheel' ? ['target', 'actual'] : ['distance'];
    let minimum = 0, maximum = card.kind === 'laser' ? 1000 : 10;
    let hasValues = false;
    for (let i = from; i < until; i++) for (const key of keys) {
      const value = samples.rows[i][key];
      if (value === null) continue;
      if (!hasValues) { minimum = Math.min(0, value); maximum = Math.max(card.kind === 'laser' ? 100 : 1, value); hasValues = true; }
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
    }
    const span = Math.max(1, maximum - minimum);
    maximum += span * .12;
    if (minimum < 0) minimum -= span * .12;
    const x = time => left + (time - start) / this.windowMs * (right - left);
    const y = value => bottom - (value - minimum) / (maximum - minimum) * (bottom - top);
    ctx.lineWidth = 1;
    ctx.font = "9px 'IBM Plex Mono',Consolas,monospace";
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    for (let tick = 0; tick <= 2; tick++) {
      const value = minimum + (maximum - minimum) * tick / 2;
      const yy = y(value);
      ctx.strokeStyle = '#e5ebe3';
      ctx.beginPath(); ctx.moveTo(left, yy); ctx.lineTo(right, yy); ctx.stroke();
      ctx.fillStyle = '#91a091';
      ctx.fillText(axisText(value), left - 5, yy);
    }
    if (minimum < 0) {
      ctx.strokeStyle = '#c4d2c6';
      ctx.beginPath(); ctx.moveTo(left, y(0)); ctx.lineTo(right, y(0)); ctx.stroke();
    }
    for (let tick = 0; tick <= 2; tick++) {
      const time = start + this.windowMs * tick / 2;
      const xx = x(time);
      ctx.fillStyle = '#91a091';
      ctx.textAlign = tick === 0 ? 'left' : tick === 2 ? 'right' : 'center';
      ctx.fillText(`${(time / 1000).toFixed(1)}s`, xx, height - 10);
    }
    ctx.save();
    ctx.beginPath(); ctx.rect(left - 2, top - 2, right - left + 4, bottom - top + 4); ctx.clip();
    keys.forEach((key, series) => {
      ctx.strokeStyle = card.kind === 'wheel' ? (series === 0 ? TARGET : ACTUAL) : LASER;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.lineWidth = 1.6;
      let previous = null;
      ctx.beginPath();
      for (let i = from; i < until; i++) {
        const row = samples.rows[i];
        const value = row[key];
        if (value === null) { previous = null; continue; }
        const xx = x(row.time), yy = y(value);
        if (!previous || row.time - previous.time > GAP_MS) ctx.moveTo(xx, yy);
        else ctx.lineTo(xx, yy);
        previous = row;
      }
      ctx.stroke();
      // Show received samples as dots while they are sparse. At high density,
      // keep endpoint/gap dots and the full line to avoid thousands of arcs.
      const sparse = until - from <= (right - left) / 3;
      for (let i = from; i < until; i++) {
        const row = samples.rows[i];
        if (row[key] === null) continue;
        if (!sparse && i > from && i < until - 1) {
          const before = samples.rows[i - 1], after = samples.rows[i + 1];
          if (before[key] !== null && after[key] !== null && row.time - before.time <= GAP_MS && after.time - row.time <= GAP_MS) continue;
        }
        ctx.beginPath(); ctx.arc(x(row.time), y(row[key]), 1.35, 0, Math.PI * 2); ctx.fill();
      }
    });
    ctx.restore();
    const latest = until > samples.start ? samples.rows[until - 1] : null;
    const fresh = latest && end - latest.time <= GAP_MS;
    const valid = latest && (card.kind === 'wheel' ? latest.actual !== null : latest.distance !== null);
    card.readout.classList.toggle('stale', !fresh || !valid);
    card.status.classList.toggle('stale', Boolean(latest && (!fresh || !valid)));
    card.status.textContent = latest ? (fresh ? (valid ? '已收到实际样本' : card.kind === 'wheel' ? '实际轮速无效 · 曲线留空' : '收到无效距离 · 曲线留空') : `无新样本 · 距上次 ${((end - latest.time) / 1000).toFixed(1)} 秒`) : (card.kind === 'wheel' ? '等待 WF / W4 样本' : '等待激光样本');
    card.readout.textContent = latest ? (card.kind === 'wheel' ? `目标 ${valueText(latest.target)} / 实际 ${valueText(latest.actual)}` : `${valueText(latest.distance)} mm`) : (card.kind === 'wheel' ? '目标 — / 实际 —' : '— mm');
    card.readout.title = latest ? `最近样本 ${(latest.time / 1000).toFixed(3)} 秒${fresh ? '' : ' · 无新样本'}${card.kind === 'wheel' ? ` · PWM ${valueText(latest.pwm)}` : ''}` : '尚未收到此通道样本';
    canvas.setAttribute('aria-label', `${card.kind === 'wheel' ? `${card.key} 轮 · ${WHEEL_POSITIONS[card.key]}` : `${LASER_NAMES[card.index]}激光`}，${card.readout.textContent}${fresh ? '' : '，无新样本'}`);
    if (!hasValues) {
      ctx.fillStyle = '#95a393';
      ctx.textAlign = 'center';
      ctx.font = "10px 'Microsoft YaHei',sans-serif";
      ctx.fillText(until > from ? '当前窗口内无有效样本' : '等待此通道数据', (left + right) / 2, (top + bottom) / 2);
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.resizeObserver?.disconnect();
    window.removeEventListener('resize', this.onResize);
    this.container.removeEventListener('change', this.onChange);
    this.container.replaceChildren();
    this.container.classList.remove('waveform-panel', 'charts-right', 'charts-left');
    for (const card of this.cards) card.samples.clear();
    this.cards.length = 0;
    this.groups.length = 0;
  }
}
