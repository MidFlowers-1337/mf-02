const { releaseExpiredBookings } = require('./booking');

const POLL_INTERVAL_MS = 60 * 1000;

let timer = null;
let running = false;

function start() {
  if (timer) return;
  running = true;
  console.log('[scheduler] 定时释放工位任务已启动，间隔 60 秒');

  timer = setInterval(() => {
    try {
      const released = releaseExpiredBookings();
      if (released.length > 0) {
        console.log(`[scheduler] 已释放 ${released.length} 个超时预约: ${released.join(', ')}`);
      }
    } catch (err) {
      console.error('[scheduler] 释放超时预约失败:', err.message);
    }
  }, POLL_INTERVAL_MS);
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
    running = false;
    console.log('[scheduler] 定时任务已停止');
  }
}

function isRunning() {
  return running;
}

module.exports = { start, stop, isRunning, POLL_INTERVAL_MS };
