import { Logger } from '../utils/logger.js';

const logger = new Logger('RecordManager');

/**
 * 记录管理器 - 负责保存、加载、删除音频分析记录
 */
export class RecordManager {
  constructor() {
    this.STORAGE_KEY = 'guqin_audio_records';
    this.MAX_RECORDS = 50;
    this.records = this.loadRecords();
  }

  /**
   * 从 localStorage 加载记录
   * @returns {Array} 记录数组
   */
  loadRecords() {
    try {
      const data = localStorage.getItem(this.STORAGE_KEY);
      if (data) {
        const records = JSON.parse(data);
        logger.info('加载记录成功', { count: records.length });
        return records;
      }
    } catch (error) {
      logger.error('加载记录失败', error);
    }
    return [];
  }

  /**
   * 保存记录到 localStorage
   */
  saveRecords() {
    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.records));
      logger.info('保存记录成功', { count: this.records.length });
    } catch (error) {
      logger.error('保存记录失败', error);
      throw new Error('保存记录失败，存储空间可能已满');
    }
  }

  /**
   * 创建新记录
   * @param {Object} recordData - 记录数据
   * @param {string} recordData.fileName - 文件名
   * @param {number} recordData.startMs - 起始时间 (ms)
   * @param {number} recordData.endMs - 结束时间 (ms)
   * @param {number} recordData.fundamentalFreq - 基频
   * @param {Array} recordData.harmonics - 倍频数组
   * @param {Object} recordData.harmonicIntensities - 倍频强度
   * @param {Object} recordData.analysisResult - 完整分析结果
   * @param {number} recordData.sampleRate - 采样率
   * @param {{upper: number[], lower: number[]}|null} recordData.waveformSnapshot - 降采样波形包络（可能为空，表示未保存波形）
   * @param {string} recordData.name - 记录名称（可选）
   * @returns {Object} 创建的记录
   */
  createRecord(recordData) {
    const startMs = recordData.startMs ?? 0;
    const endMs = recordData.endMs ?? startMs;
    const record = {
      id: this.generateId(),
      name: recordData.name || `${recordData.fileName} - ${this.formatTimestamp()}`,
      fileName: recordData.fileName,
      startMs,
      endMs,
      durationMs: endMs - startMs,
      fundamentalFreq: recordData.fundamentalFreq,
      harmonics: recordData.harmonics,
      harmonicIntensities: recordData.harmonicIntensities ?? null,
      analysisResult: recordData.analysisResult,
      // 保存当时的采样率和波形包络，回放时才能还原真实时间刻度与波形起伏
      sampleRate: recordData.sampleRate ?? null,
      waveformSnapshot: recordData.waveformSnapshot ?? null,
      createdAt: Date.now(),
      note: ''
    };

    this.records.unshift(record);

    if (this.records.length > this.MAX_RECORDS) {
      this.records = this.records.slice(0, this.MAX_RECORDS);
    }

    this.saveRecords();
    logger.info('创建新记录', { id: record.id, name: record.name });

    return record;
  }

  /**
   * 获取所有记录
   * @returns {Array} 记录数组
   */
  getAllRecords() {
    return [...this.records];
  }

  /**
   * 根据 ID 获取记录
   * @param {string} id - 记录 ID
   * @returns {Object|null} 记录对象
   */
  getRecord(id) {
    return this.records.find(r => r.id === id) || null;
  }

  /**
   * 更新记录
   * @param {string} id - 记录 ID
   * @param {Object} updates - 要更新的字段
   * @returns {Object|null} 更新后的记录
   */
  updateRecord(id, updates) {
    const index = this.records.findIndex(r => r.id === id);
    if (index === -1) {
      logger.warn('未找到要更新的记录', { id });
      return null;
    }

    this.records[index] = { ...this.records[index], ...updates };
    this.saveRecords();
    logger.info('更新记录', { id });

    return this.records[index];
  }

  /**
   * 删除记录
   * @param {string} id - 记录 ID
   * @returns {boolean} 是否删除成功
   */
  deleteRecord(id) {
    const index = this.records.findIndex(r => r.id === id);
    if (index === -1) {
      logger.warn('未找到要删除的记录', { id });
      return false;
    }

    this.records.splice(index, 1);
    this.saveRecords();
    logger.info('删除记录', { id });

    return true;
  }

  /**
   * 清空所有记录
   */
  clearAllRecords() {
    this.records = [];
    this.saveRecords();
    logger.info('清空所有记录');
  }

  /**
   * 生成唯一 ID
   * @returns {string} 唯一 ID
   */
  generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
  }

  /**
   * 格式化时间戳
   * @returns {string} 格式化的时间字符串
   */
  formatTimestamp() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}`;
  }

  /**
   * 格式化日期显示
   * @param {number} timestamp - 时间戳
   * @returns {string} 格式化的日期字符串
   */
  formatDate(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now - date;

    if (diff < 60000) {
      return '刚刚';
    } else if (diff < 3600000) {
      return `${Math.floor(diff / 60000)} 分钟前`;
    } else if (diff < 86400000) {
      return `${Math.floor(diff / 3600000)} 小时前`;
    } else if (diff < 604800000) {
      return `${Math.floor(diff / 86400000)} 天前`;
    } else {
      return this.formatTimestampFull(timestamp);
    }
  }

  /**
   * 完整格式化时间戳
   * @param {number} timestamp - 时间戳
   * @returns {string} 格式化的时间字符串
   */
  formatTimestampFull(timestamp) {
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}`;
  }

  /**
   * 导出记录为 JSON
   * @param {string} id - 记录 ID（可选，不传则导出所有）
   * @returns {string} JSON 字符串
   */
  exportRecords(id = null) {
    const data = id ? this.getRecord(id) : this.getAllRecords();
    return JSON.stringify(data, null, 2);
  }

  /**
   * 导入记录
   * @param {string} jsonData - JSON 字符串
   * @returns {number} 导入的记录数量
   */
  importRecords(jsonData) {
    try {
      const data = JSON.parse(jsonData);
      const records = Array.isArray(data) ? data : [data];
      let count = 0;

      for (const record of records) {
        if (this.validateRecord(record)) {
          record.id = this.generateId();
          record.createdAt = Date.now();
          this.records.unshift(record);
          count++;
        }
      }

      if (this.records.length > this.MAX_RECORDS) {
        this.records = this.records.slice(0, this.MAX_RECORDS);
      }

      this.saveRecords();
      logger.info('导入记录', { count });
      return count;
    } catch (error) {
      logger.error('导入记录失败', error);
      throw new Error('导入记录失败，数据格式无效');
    }
  }

  /**
   * 验证记录数据
   * @param {Object} record - 记录数据
   * @returns {boolean} 是否有效
   */
  validateRecord(record) {
    return (
      record &&
      typeof record.fileName === 'string' &&
      typeof record.startMs === 'number' &&
      typeof record.endMs === 'number' &&
      typeof record.fundamentalFreq === 'number' &&
      Array.isArray(record.harmonics)
    );
  }
}
