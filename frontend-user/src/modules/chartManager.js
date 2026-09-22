import Chart from 'chart.js/auto';
import annotationPlugin from 'chartjs-plugin-annotation';
import { Logger } from '../utils/logger.js';

Chart.register(annotationPlugin);

const logger = new Logger('ChartManager');

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

    // 热力图为手动绘制，需要自行维护重绘状态
    this.lastHeatmapData = null;
    this.lastHeatmapStartMs = 0;
    this.resizeTimer = null;

    window.addEventListener('resize', () => {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => this.handleResize(), 150);
    });
  }

  /**
   * 从原始采样数据构建波形包络（上下边界），用于降采样存储和绘制
   * @param {Float32Array} audioData - 原始音频采样
   * @param {number} bucketCount - 降采样桶数
   * @returns {{upper: number[], lower: number[]}} 每个桶的最大/最小振幅
   */
  buildWaveformEnvelope(audioData, bucketCount = 1000) {
    const length = audioData.length;
    const upper = new Array(bucketCount).fill(0);
    const lower = new Array(bucketCount).fill(0);

    if (length === 0) {
      return { upper, lower };
    }

    const bucketSize = length / bucketCount;
    for (let b = 0; b < bucketCount; b++) {
      const start = Math.floor(b * bucketSize);
      const end = Math.max(start + 1, Math.floor((b + 1) * bucketSize));
      let max = -Infinity;
      let min = Infinity;
      for (let i = start; i < end && i < length; i++) {
        const v = audioData[i];
        if (v > max) max = v;
        if (v < min) min = v;
      }
      upper[b] = max === -Infinity ? 0 : max;
      lower[b] = min === Infinity ? 0 : min;
    }

    return { upper, lower };
  }

  /**
   * 更新所有图表
   * @param {Object} analysisResult - 分析结果
   * @param {Float32Array|null} audioData - 当前分析区间的音频采样（记录回放时可能为 null）
   * @param {number} sampleRate - 采样率
   * @param {Object} [options]
   * @param {number} [options.startMs=0] - 分析区间在原音频中的起始时间 (ms)
   * @param {number} [options.endMs] - 分析区间结束时间 (ms)，记录回放时用于计算时间刻度
   * @param {{upper: number[], lower: number[]}|null} [options.waveformSnapshot=null] - 记录保存的波形包络
   */
  updateAllCharts(analysisResult, audioData, sampleRate, options = {}) {
    logger.info('更新所有图表');
    const { startMs = 0, endMs, waveformSnapshot = null } = options;

    if (waveformSnapshot) {
      // 记录回放：使用保存时的真实采样率和包络还原波形
      this.updateWaveformChart(null, sampleRate, { startMs, endMs, waveformSnapshot });
    } else if (audioData) {
      // 实时分析
      this.updateWaveformChart(audioData, sampleRate, { startMs });
    } else {
      // 既没有实时音频，也没有保存波形 —— 明确提示，不画假线
      this.showWaveformPlaceholder();
    }

    this.updateSpectrumChart(analysisResult);
    this.updateHeatmapChart(analysisResult.heatmapData, startMs);
    this.updateFrequencyBandCharts(analysisResult);
  }

  /**
   * 窗口尺寸变化时重绘。Chart.js 图表自带响应式，只需处理手动绘制的热力图。
   */
  handleResize() {
    if (this.lastHeatmapData) {
      this.renderHeatmap(this.lastHeatmapData, this.lastHeatmapStartMs);
    }
  }

  /**
   * 清除所有图表
   */
  clearAllCharts() {
    Object.values(this.charts).forEach(chart => {
      if (chart) {
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
    this.showWaveformPlaceholder(false);
  }

  /**
   * 显示/隐藏"未保存波形数据"占位提示
   * @param {boolean} show
   */
  showWaveformPlaceholder(show = true) {
    const placeholder = document.getElementById('waveformPlaceholder');
    const canvas = document.getElementById('waveformChart');
    if (placeholder) {
      placeholder.style.display = show ? 'flex' : 'none';
    }
    if (canvas) {
      canvas.style.display = show ? 'none' : 'block';
    }
    if (show && this.charts.waveform) {
      this.charts.waveform.destroy();
      this.charts.waveform = null;
    }
  }

  /**
   * 更新波形图
   * @param {Float32Array|null} audioData - 原始采样（实时分析时传入）
   * @param {number} sampleRate - 采样率
   * @param {Object} [options]
   * @param {number} [options.startMs=0] - 区间起始时间 (ms)
   * @param {{upper: number[], lower: number[]}} [options.waveformSnapshot=null] - 记录保存的波形包络
   */
  updateWaveformChart(audioData, sampleRate, options = {}) {
    const { startMs = 0, waveformSnapshot = null } = options;
    const canvas = document.getElementById('waveformChart');
    const ctx = canvas.getContext('2d');

    if (this.charts.waveform) {
      this.charts.waveform.destroy();
      this.charts.waveform = null;
    }
    this.showWaveformPlaceholder(false);

    let upper;
    let lower;
    let pointCount;
    let segmentDurationMs; // 每个点代表的时长，用于还原真实时间刻度

    if (waveformSnapshot) {
      // 记录回放：按保存时的区间时长计算时间刻度
      upper = waveformSnapshot.upper;
      lower = waveformSnapshot.lower;
      pointCount = upper.length;
      segmentDurationMs = (options.endMs - startMs) / pointCount;
    } else {
      const maxPoints = 1000;
      const envelope = this.buildWaveformEnvelope(audioData, maxPoints);
      upper = envelope.upper;
      lower = envelope.lower;
      pointCount = upper.length;
      segmentDurationMs = (audioData.length / sampleRate) * 1000 / pointCount;
    }

    // 标签使用区间在原音频中的绝对时间，与记录的分析区间对齐
    const labels = upper.map((_, i) => {
      const ms = startMs + i * segmentDurationMs;
      return ms >= 100 ? Math.round(ms).toString() : ms.toFixed(1);
    });

    this.charts.waveform = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: '上包络',
            data: upper,
            borderColor: '#8B4513',
            backgroundColor: 'rgba(139, 69, 19, 0.15)',
            borderWidth: 1,
            pointRadius: 0,
            fill: '+1'
          },
          {
            label: '下包络',
            data: lower,
            borderColor: '#8B4513',
            backgroundColor: 'rgba(139, 69, 19, 0.15)',
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
              label: () => null
            }
          }
        },
        scales: {
          x: {
            title: { display: true, text: `时间 (ms，相对原音频，区间起点 ${startMs} ms)` },
            ticks: { maxTicksLimit: 10 }
          },
          y: {
            title: { display: true, text: '振幅' },
            suggestedMin: -1,
            suggestedMax: 1
          }
        },
        animation: false
      }
    });
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

    const { fundamentalFreq, harmonics, frequencies, magnitudes, minFreq, maxFreq } = analysisResult;
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
   * 更新热力图
   * @param {Object} heatmapData - 热力图数据
   * @param {number} startMs - 区间起始时间 (ms)，时间标签按此偏移
   */
  updateHeatmapChart(heatmapData, startMs = 0) {
    this.lastHeatmapData = heatmapData;
    this.lastHeatmapStartMs = startMs;
    this.renderHeatmap(heatmapData, startMs);
  }

  /**
   * 实际绘制热力图（窗口尺寸变化时可直接重绘）
   */
  renderHeatmap(heatmapData, startMs = 0) {
    const canvas = document.getElementById('heatmapChart');
    if (!canvas || canvas.offsetParent === null) {
      // 容器处于隐藏状态时没有尺寸，等显示后由调用方再次绘制
      return;
    }
    const ctx = canvas.getContext('2d');

    if (this.charts.heatmap) {
      this.charts.heatmap = null;
    }

    if (!heatmapData || !heatmapData.data || heatmapData.data.length === 0) {
      this.clearHeatmapCanvas(canvas, ctx);
      ctx.fillStyle = '#999';
      ctx.font = '13px Arial';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('该区间过短，无热力图数据', canvas.width / 2, canvas.height / 2);
      return;
    }

    const { data, timeLabels, freqLabels } = heatmapData;

    // 按容器实际尺寸绘制，窗口缩放后重绘才能对齐
    const width = Math.max(100, canvas.parentElement.clientWidth - 40);
    const height = 200;
    const leftPad = 48;
    const bottomPad = 20;
    const topPad = 4;
    canvas.width = width;
    canvas.height = height;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const innerWidth = width - leftPad;
    const innerHeight = height - bottomPad - topPad;
    const cellWidth = innerWidth / data.length;
    const cellHeight = innerHeight / freqLabels.length;

    // 清除画布
    ctx.clearRect(0, 0, width, height);

    // 绘制热力图单元格
    data.forEach((frame, x) => {
      frame.forEach((value, y) => {
        const color = this.getHeatmapColor(value);
        ctx.fillStyle = color;
        ctx.fillRect(
          leftPad + x * cellWidth,
          topPad + (freqLabels.length - 1 - y) * cellHeight,
          cellWidth + 1,
          cellHeight + 1
        );
      });
    });

    // 绘制频率标签
    ctx.fillStyle = '#666';
    ctx.font = '10px Arial';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    freqLabels.forEach((label, i) => {
      const y = topPad + (freqLabels.length - 1 - i) * cellHeight + cellHeight / 2;
      ctx.fillText(label, leftPad - 6, y);
    });

    // 绘制时间轴标签（叠加区间起始偏移，与记录的分析区间对齐）
    ctx.fillStyle = '#666';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const labelStep = Math.max(1, Math.floor(timeLabels.length / 10));
    for (let i = 0; i < timeLabels.length; i += labelStep) {
      const x = leftPad + i * cellWidth + cellWidth / 2;
      const ms = startMs + Number(timeLabels[i]);
      const labelText = ms >= 100 ? Math.round(ms) : ms.toFixed(1);
      ctx.fillText(`${labelText}ms`, x, topPad + innerHeight + 4);
    }
  }

  /**
   * 清除热力图画布
   */
  clearHeatmapCanvas(canvas, ctx) {
    const width = Math.max(100, canvas.parentElement.clientWidth - 40);
    canvas.width = width;
    canvas.height = 200;
    canvas.style.width = `${width}px`;
    canvas.style.height = '200px';
    ctx.clearRect(0, 0, width, 200);
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
