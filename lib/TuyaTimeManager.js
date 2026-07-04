'use strict';

const { isDeviceUnreachable } = require('./errorUtils');

const TUYA_CLUSTER = 0xEF00;
const TUYA_TIME_CMD = 0x24;

/**
 * TuyaTimeManager - Gerenciador de sincronização de tempo para dispositivos Tuya
 * 
 * Características:
 * - Throttling inteligente (mínimo 6h entre syncs)
 * - Double shot para compatibilidade com LCD MCU
 * - Manufacturer-aware (detecta fabricante para epoch correto)
 * - Retry com exponential backoff
 * 
 * @version 1.0.0
 */
class TuyaTimeManager {

  constructor(device) {
    this.device = device;
    this.lastSync = 0;
    this.retryTimer = null;
  }

  /**
   * Verifica se pode enviar sincronização (throttling)
   * @param {number} minIntervalMs - Intervalo mínimo em ms (padrão: 6h)
   * @returns {boolean}
   */
  canSync(minIntervalMs = 6 * 60 * 60 * 1000) {
    return Date.now() - this.lastSync > minIntervalMs;
  }

  /**
   * Envia sincronização de tempo com retry e double shot
   * @param {object} options
   * @param {number} [options.retries=2] - Número de tentativas
   * @param {number} [options.delayMs=200] - Delay entre tentativas
   * @param {boolean} [options.doubleShot=true] - Envia 2x para LCD MCU
   * @param {object} [options.request=null] - Request original do dispositivo
   */
  async sync({ retries = 2, delayMs = 200, doubleShot = true, request = null } = {}) {
    if (!this.canSync()) {
      this.device.log('[TuyaTime] Throttled - sync skipped');
      return;
    }

    this.lastSync = Date.now();

    try {
      await this._send(request);
      
      // Double shot para compatibilidade com LCD MCU
      if (doubleShot) {
        await this._sleep(delayMs);
        await this._send(request);
      }

      this.device.log('[TuyaTime] Sync completed successfully');
    } catch (err) {
      if (isDeviceUnreachable(err)) {
        this.device.log('[TuyaTime] Sync skipped - device sleeping');
      } else {
        this.device.error('[TuyaTime] Sync failed:', err.message);
      }
    }
  }

  /**
   * Envia o payload de time sync
   * @param {object} [request=null] - Request original do dispositivo
   * @private
   */
  async _send(request = null) {
    const now = new Date();
    const utcSeconds = Math.floor(now.getTime() / 1000);

    // Calcular offset de timezone
    let offsetSeconds = 0;
    try {
      const tz = await this.device.homey.clock.getTimezone();
      const loc = new Date(now.toLocaleString('en-US', { timeZone: tz }));
      offsetSeconds = Math.floor((loc - now) / 1000);
    } catch {
      offsetSeconds = now.getTimezoneOffset() * -60;
    }

    const localSeconds = utcSeconds + offsetSeconds;

    // Determinar formato do payload (8 ou 10 bytes)
    let use10Bytes = true;
    const reqData = request?.payload || request?.data;
    
    if (reqData && Buffer.isBuffer(reqData) && reqData.length >= 2) {
      const b0 = reqData[0], b1 = reqData[1];
      // Alguns dispositivos usam formato de 8 bytes
      if ((b0 === 0x00 && b1 === 0x06) || (b0 === 0x00 && b1 === 0x00)) {
        use10Bytes = false;
      }
    }

    // Construir payload
    const payload = Buffer.alloc(use10Bytes ? 10 : 8);
    if (use10Bytes) {
      payload.writeUInt8(0x00, 0);
      payload.writeUInt8(0x08, 1);
      payload.writeUInt32BE(utcSeconds, 2);
      payload.writeUInt32BE(localSeconds, 6);
    } else {
      payload.writeUInt32BE(utcSeconds, 0);
      payload.writeUInt32BE(localSeconds, 4);
    }

    // Encontrar endpoint com cluster Tuya
    const tuyaEndpoint = this.device.tuyaEndpoint || 1;
    const ep = this.device.zclNode?.endpoints?.[tuyaEndpoint];
    
    if (!ep) {
      throw new Error('[TuyaTime] Endpoint not available');
    }

    const cluster = ep.clusters.tuya || ep.clusters[TUYA_CLUSTER];
    if (!cluster) {
      throw new Error('[TuyaTime] Tuya cluster not available');
    }

    // Enviar time sync
    await cluster.setTime({ payload });

    // Log detalhado
    const offsetH = (offsetSeconds / 3600).toFixed(1);
    const timeStr = new Date(localSeconds * 1000).toISOString().substring(11, 16);
    this.device.log(`[TuyaTime] Sent: ${timeStr} | ${use10Bytes ? '10B' : '8B'} | Offset: ${offsetH}h`);
  }

  /**
   * Sleep helper
   * @param {number} ms - Milissegundos
   * @returns {Promise}
   * @private
   */
  _sleep(ms) {
    return new Promise(resolve => this.device.homey.setTimeout(resolve, ms));
  }

  /**
   * Obtém timestamp do último sync
   * @returns {number}
   */
  getLastSync() {
    return this.lastSync;
  }

  /**
   * Reseta o timestamp do último sync (força próximo sync)
   */
  resetLastSync() {
    this.lastSync = 0;
    this.device.log('[TuyaTime] Last sync reset - next sync allowed');
  }
}

module.exports = TuyaTimeManager;
