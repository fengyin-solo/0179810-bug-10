import Chart from 'chart.js/auto';
import annotationPlugin from 'chartjs-plugin-annotation';
import { Logger } from '../utils/logger.js';

Chart.register(annotationPlugin);

const logger = new Logger('ChartManager');

/**
 * 波形降采样的最大分桶数（每个桶保留 min/max 包络）
 */
const WAVEFORM_MAX_BUCKETS = 1000;

/**
 * 图表管理器 - 负责所有图表的创建和更新
 */
export class ChartManager {
  constructor() {
    this.charts = {
      waveform: null,
      spectrum: null,
      heatmap: null,
      lowFreq: null,
      midFreq: null,
      highFreq: null
    };

    // 供窗口 resize 时重绘使用的缓存
    this.lastHeatmapData = null;
    this.lastStartMs = 0;

    // 窗口大小变化后重绘（手绘热力图需要手动重画，Chart.js 图表主动 resize）
    this._resizeTimer = null;
    this._resizeHandler = () => {
      clearTimeout(this._resizeTimer);
      this._resizeTimer = setTimeout(() => this.handleResize(), 200);
    };
    window.addEventListener('resize', this._resizeHandler);
  }

  /**
   * 更新所有图表（实时分析场景）
   * @param {Object} analysisResult - 分析结果
   * @param {Float32Array} audioData - 当前分析区间的原始采样数据
   * @param {number} sampleRate - 采样率
   * @param {number} [startMs=0] - 分析区间在整段音频中的起始时间 (ms)
   */
  updateAllCharts(analysisResult, audioData, sampleRate, startMs = 0) {
    logger.info('更新所有图表', { startMs, sampleRate });

    this.lastStartMs = startMs || 0;

    this.updateWaveformChart(audioData, sampleRate, this.lastStartMs);
    this.updateSpectrumChart(analysisResult);
    this.updateHeatmapChart(analysisResult.heatmapData);
    this.updateFrequencyBandCharts(analysisResult);
  }

  /**
   * 从已保存记录恢复图表（应用记录场景）
   * 波形优先使用记录中持久化的波形快照；未保存时显示明确的缺数据说明，
   * 绝不用全零数据画一条假直线。
   * @param {Object} record - 记录对象
   */
  updateChartsFromRecord(record) {
    const result = record.analysisResult;
    this.lastStartMs = record.startMs || 0;

    this.updateSpectrumChart(result);
    this.updateHeatmapChart(result.heatmapData);
    this.updateFrequencyBandCharts(result);

    if (this.isWaveformSnapshot(record.waveformSnapshot)) {
      this.restoreWaveformChart(record.waveformSnapshot);
    } else {
      logger.info('记录未保存波形数据，显示缺数据说明', { id: record.id });
      this.showWaveformUnavailable(
        '本记录未保存波形数据',
        '保存该记录时没有存储原始音频采样，因此无法还原声音起伏。频谱图、热力图等分析结果仍可正常查看；重新上传原音频并按记录区间再次分析即可看到波形。'
      );
    }
  }

  /**
   * 窗口大小变化时重绘图表
   */
  handleResize() {
    const container = document.getElementById('chartContainer');
    if (!container || container.style.display === 'none') return;

    // 热力图为手绘 canvas，单独按新宽度重绘；其余 Chart.js 图表调用 resize
    this.drawHeatmap();

    Object.entries(this.charts).forEach(([key, chart]) => {
      if (key === 'heatmap') return;
      if (chart && typeof chart.resize === 'function') {
        try {
          chart.resize();
        } catch (error) {
          logger.warn('图表 resize 失败', error);
        }
      }
    });
  }

  /**
   * 清除所有图表
   */
  clearAllCharts() {
    Object.values(this.charts).forEach(chart => {
      if (chart && typeof chart.destroy === 'function') {
        chart.destroy();
      }
    });
    this.charts = {
      waveform: null,
      spectrum: null,
      heatmap: null,
      lowFreq: null,
      midFreq: null,
      highFreq: null
    };
    this.lastHeatmapData = null;
    this.lastStartMs = 0;
    this.hideWaveformOverlay();
  }

  /**
   * 将采样数据降采样为 min/max 包络
   * 使用每个桶的最小值/最大值而不是单点抽样，避免高频信号被抽成接近 0 的平线
   * @param {Float32Array|Array<number>} audioData
   * @param {number} sampleRate
   * @param {number} [startMs=0]
   * @returns {{labels: string[], min: number[], max: number[], samplesPerBucket: number}}
   */
  buildWaveformEnvelope(audioData, sampleRate, startMs = 0) {
    const n = audioData.length;
    const samplesPerBucket = Math.max(1, Math.ceil(n / WAVEFORM_MAX_BUCKETS));
    const buckets = Math.max(1, Math.ceil(n / samplesPerBucket));

    const labels = new Array(buckets);
    const min = new Array(buckets);
    const max = new Array(buckets);

    for (let b = 0; b < buckets; b++) {
      const start = b * samplesPerBucket;
      const end = Math.min(n, start + samplesPerBucket);

      let lo = Infinity;
      let hi = -Infinity;
      for (let i = start; i < end; i++) {
        const v = audioData[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }

      // 时间标签为该桶在整段音频中的绝对时间 (ms)
      labels[b] = (startMs + (start / sampleRate) * 1000).toFixed(1);
      min[b] = lo === Infinity ? 0 : lo;
      max[b] = hi === -Infinity ? 0 : hi;
    }

    return { labels, min, max, samplesPerBucket };
  }

  /**
   * 构建可序列化并随记录持久化的波形快照
   * @param {Float32Array} audioData - 分析区间的原始采样
   * @param {number} sampleRate - 采样率
   * @param {number} [startMs=0] - 区间起始时间 (ms)
   * @returns {Object|null} 波形快照；数据不足时返回 null
   */
  buildWaveformSnapshot(audioData, sampleRate, startMs = 0) {
    if (!audioData || audioData.length === 0 || !sampleRate) {
      return null;
    }

    const envelope = this.buildWaveformEnvelope(audioData, sampleRate, startMs);
    return {
      version: 1,
      sampleRate,
      startMs: startMs || 0,
      sampleCount: audioData.length,
      samplesPerBucket: envelope.samplesPerBucket,
      labels: envelope.labels,
      min: envelope.min,
      max: envelope.max
    };
  }

  /**
   * 判断对象是否为有效的波形快照
   */
  isWaveformSnapshot(snapshot) {
    return !!(
      snapshot &&
      typeof snapshot.sampleRate === 'number' &&
      snapshot.sampleRate > 0 &&
      Array.isArray(snapshot.labels) &&
      Array.isArray(snapshot.min) &&
      Array.isArray(snapshot.max) &&
      snapshot.labels.length > 0 &&
      snapshot.min.length === snapshot.labels.length &&
      snapshot.max.length === snapshot.labels.length
    );
  }

  /**
   * 更新波形图（实时分析）
   */
  updateWaveformChart(audioData, sampleRate, startMs = 0) {
    this.hideWaveformOverlay();
    const envelope = this.buildWaveformEnvelope(audioData, sampleRate, startMs);
    this.renderWaveformEnvelope(envelope.labels, envelope.min, envelope.max);
  }

  /**
   * 从记录中的波形快照恢复波形图
   */
  restoreWaveformChart(snapshot) {
    this.hideWaveformOverlay();
    this.renderWaveformEnvelope(snapshot.labels, snapshot.min, snapshot.max);
  }

  /**
   * 使用 min/max 包络数据渲染波形图
   */
  renderWaveformEnvelope(labels, minValues, maxValues) {
    const canvas = document.getElementById('waveformChart');
    const ctx = canvas.getContext('2d');

    if (this.charts.waveform) {
      this.charts.waveform.destroy();
      this.charts.waveform = null;
    }

    const brown = '#8B4513';
    const brownFill = 'rgba(139, 69, 19, 0.18)';

    this.charts.waveform = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: '上包络',
            data: maxValues,
            borderColor: brown,
            backgroundColor: brownFill,
            borderWidth: 1,
            pointRadius: 0,
            fill: '+1'
          },
          {
            label: '下包络',
            data: minValues,
            borderColor: brown,
            backgroundColor: brownFill,
            borderWidth: 1,
            pointRadius: 0,
            fill: false
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: (items) => `时间: ${items[0].label} ms`,
              label: (context) => {
                const value = context.parsed.y.toFixed(4);
                return context.datasetIndex === 0 ? `峰值: ${value}` : `谷值: ${value}`;
              }
            }
          }
        },
        scales: {
          x: {
            title: { display: true, text: '时间 (ms，相对音频起点)' },
            ticks: { maxTicksLimit: 10, autoSkip: true }
          },
          y: {
            title: { display: true, text: '振幅' },
            suggestedMin: -1,
            suggestedMax: 1
          }
        },
        animation: false,
        interaction: { mode: 'index', intersect: false }
      }
    });
  }

  /**
   * 显示"记录未保存波形数据"的说明，覆盖波形图区域
   */
  showWaveformUnavailable(title, hint) {
    if (this.charts.waveform) {
      this.charts.waveform.destroy();
      this.charts.waveform = null;
    }

    const overlay = document.getElementById('waveformNoData');
    if (overlay) {
      const titleEl = overlay.querySelector('.no-data-title');
      const hintEl = overlay.querySelector('.no-data-hint');
      if (titleEl) titleEl.textContent = title;
      if (hintEl) hintEl.textContent = hint;
      overlay.style.display = 'flex';
    }
  }

  /**
   * 隐藏波形缺数据说明
   */
  hideWaveformOverlay() {
    const overlay = document.getElementById('waveformNoData');
    if (overlay) {
      overlay.style.display = 'none';
    }
  }

  /**
   * 更新频谱图
   */
  updateSpectrumChart(analysisResult) {
    const canvas = document.getElementById('spectrumChart');
    const ctx = canvas.getContext('2d');

    if (this.charts.spectrum) {
      this.charts.spectrum.destroy();
    }

    const { fundamentalFreq, harmonics, frequencies, magnitudes } = analysisResult;
    const allHarmonics = [fundamentalFreq, ...harmonics];

    // 创建用于显示的数据点
    const chartData = [];
    const chartLabels = [];

    // 为每个谐波创建数据点
    allHarmonics.forEach((harmonic, index) => {
      // 找到最接近的实际数据
      let closestMag = 0;
      let minDist = Infinity;

      for (let i = 0; i < frequencies.length; i++) {
        const dist = Math.abs(frequencies[i] - harmonic);
        if (dist < minDist) {
          minDist = dist;
          closestMag = magnitudes[i];
        }
      }

      chartLabels.push(index === 0 ? `基频\n${harmonic.toFixed(0)}Hz` : `${index + 1}倍频\n${harmonic.toFixed(0)}Hz`);
      chartData.push(closestMag);
    });

    // 归一化
    const maxMag = Math.max(...chartData);
    const normalizedData = chartData.map(v => maxMag > 0 ? (v / maxMag) * 100 : 0);

    // 创建颜色数组 - 基频用特殊颜色
    const colors = normalizedData.map((_, i) =>
      i === 0 ? '#D2691E' : '#8B4513'
    );

    this.charts.spectrum = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: chartLabels,
        datasets: [{
          label: '相对强度 (%)',
          data: normalizedData,
          backgroundColor: colors,
          borderColor: colors.map(c => c),
          borderWidth: 1
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (context) => `强度: ${context.raw.toFixed(1)}%`
            }
          }
        },
        scales: {
          x: {
            title: { display: true, text: '频率' }
          },
          y: {
            title: { display: true, text: '相对强度 (%)' },
            min: 0,
            max: 100
          }
        }
      }
    });
  }

  /**
   * 更新热力图（缓存数据后绘制，供 resize 时重绘）
   */
  updateHeatmapChart(heatmapData) {
    this.lastHeatmapData = heatmapData;
    this.drawHeatmap();
  }

  /**
   * 按当前画布宽度绘制热力图
   */
  drawHeatmap() {
    const heatmapData = this.lastHeatmapData;
    if (!heatmapData) return;

    const canvas = document.getElementById('heatmapChart');
    const ctx = canvas.getContext('2d');
    const { data, timeLabels, freqLabels } = heatmapData;

    if (this.charts.heatmap && typeof this.charts.heatmap.destroy === 'function') {
      this.charts.heatmap.destroy();
      this.charts.heatmap = null;
    }

    // 标记为手绘图表，resize 时统一处理
    this.charts.heatmap = {
      resize: () => this.drawHeatmap(),
      destroy: () => { /* 手绘 canvas 无需销毁 Chart 实例 */ }
    };

    // 绘制热力图
    const width = canvas.parentElement.clientWidth - 40;
    const height = 200;

    // 容器尚不可见（宽度为 0）时跳过本次绘制，缓存的数据会在 resize 时重绘
    if (width <= 0) {
      logger.warn('热力图容器宽度为 0，跳过绘制（将在窗口变化时重试）');
      return;
    }

    canvas.width = width;
    canvas.height = height;

    const cellWidth = width / data.length;
    const cellHeight = height / freqLabels.length;

    // 清除画布
    ctx.clearRect(0, 0, width, height);

    // 绘制热力图单元格
    data.forEach((frame, x) => {
      frame.forEach((value, y) => {
        const color = this.getHeatmapColor(value);
        ctx.fillStyle = color;
        ctx.fillRect(x * cellWidth, (freqLabels.length - 1 - y) * cellHeight, cellWidth + 1, cellHeight + 1);
      });
    });

    // 绘制频率标签
    ctx.fillStyle = '#333';
    ctx.font = '10px Arial';
    ctx.textAlign = 'right';
    freqLabels.forEach((label, i) => {
      const y = (freqLabels.length - 1 - i) * cellHeight + cellHeight / 2 + 3;
      // 标签绘制在左侧
    });

    // 绘制时间轴标签（加上分析区间的起始时间，与记录的分析区间保持一致）
    ctx.textAlign = 'center';
    const labelStep = Math.max(1, Math.floor(timeLabels.length / 10));
    for (let i = 0; i < timeLabels.length; i += labelStep) {
      const x = i * cellWidth + cellWidth / 2;
      const absoluteMs = Number(timeLabels[i]) + (this.lastStartMs || 0);
      ctx.fillText(`${absoluteMs.toFixed(0)}ms`, x, height - 5);
    }
  }

  /**
   * 获取热力图颜色
   */
  getHeatmapColor(value) {
    // 使用科学可视化常用的颜色映射
    const colors = [
      { pos: 0, r: 49, g: 54, b: 149 },    // 深蓝
      { pos: 0.25, r: 69, g: 117, b: 180 }, // 蓝
      { pos: 0.5, r: 255, g: 255, b: 191 }, // 黄
      { pos: 0.75, r: 253, g: 174, b: 97 }, // 橙
      { pos: 1, r: 165, g: 0, b: 38 }       // 红
    ];

    // 找到对应的颜色区间
    let lower = colors[0];
    let upper = colors[colors.length - 1];

    for (let i = 0; i < colors.length - 1; i++) {
      if (value >= colors[i].pos && value <= colors[i + 1].pos) {
        lower = colors[i];
        upper = colors[i + 1];
        break;
      }
    }

    // 线性插值
    const range = upper.pos - lower.pos;
    const t = range > 0 ? (value - lower.pos) / range : 0;

    const r = Math.round(lower.r + (upper.r - lower.r) * t);
    const g = Math.round(lower.g + (upper.g - lower.g) * t);
    const b = Math.round(lower.b + (upper.b - lower.b) * t);

    return `rgb(${r}, ${g}, ${b})`;
  }

  /**
   * 更新频率区域图表
   */
  updateFrequencyBandCharts(analysisResult) {
    const { frequencyBands, fundamentalFreq } = analysisResult;

    // 低频区图表
    this.updateBandChart('lowFreqChart', 'lowFreq', frequencyBands.low, '低频区', fundamentalFreq, 1);

    // 中频区图表
    this.updateBandChart('midFreqChart', 'midFreq', frequencyBands.mid, '中频区', fundamentalFreq, 5);

    // 高频区图表
    this.updateBandChart('highFreqChart', 'highFreq', frequencyBands.high, '高频区', fundamentalFreq, 9);
  }

  /**
   * 更新单个频率区域图表
   */
  updateBandChart(canvasId, chartKey, bandData, title, fundamentalFreq, startHarmonic) {
    const canvas = document.getElementById(canvasId);
    const ctx = canvas.getContext('2d');

    if (this.charts[chartKey]) {
      this.charts[chartKey].destroy();
    }

    if (bandData.length === 0) {
      // 显示空状态
      this.charts[chartKey] = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: ['无数据'],
          datasets: [{
            data: [0],
            backgroundColor: '#E0E0E0'
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } }
        }
      });
      return;
    }

    const labels = bandData.map((d, i) => {
      const harmonicNum = startHarmonic + i;
      return harmonicNum === 1 ? '基频' : `${harmonicNum}倍频`;
    });

    const data = bandData.map(d => d.magnitude);

    // 归一化
    const maxVal = Math.max(...data);
    const normalizedData = data.map(v => maxVal > 0 ? (v / maxVal) * 100 : 0);

    // 根据区域设置不同颜色
    const colorMap = {
      lowFreq: '#4CAF50',   // 绿色
      midFreq: '#2196F3',   // 蓝色
      highFreq: '#9C27B0'   // 紫色
    };

    this.charts[chartKey] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: '相对强度 (%)',
          data: normalizedData,
          backgroundColor: colorMap[chartKey],
          borderColor: colorMap[chartKey],
          borderWidth: 1
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              afterLabel: (context) => {
                const harmonicNum = startHarmonic + context.dataIndex;
                const freq = fundamentalFreq * harmonicNum;
                return `频率: ${freq.toFixed(1)} Hz`;
              }
            }
          }
        },
        scales: {
          x: {
            title: { display: false }
          },
          y: {
            title: { display: true, text: '强度 (%)' },
            min: 0,
            max: 100
          }
        }
      }
    });
  }
}
