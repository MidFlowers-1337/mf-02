const Koa = require('koa');
const bodyParser = require('koa-bodyparser');
const serve = require('koa-static');
const path = require('path');
const fs = require('fs');
const { init: initDb } = require('./db');
const scheduler = require('./scheduler');
const router = require('./routes');

initDb();

const app = new Koa();

app.use(async (ctx, next) => {
  ctx.set('Access-Control-Allow-Origin', '*');
  ctx.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  ctx.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (ctx.method === 'OPTIONS') {
    ctx.status = 204;
    return;
  }
  await next();
});

app.use(bodyParser());

app.use(router.routes());
app.use(router.allowedMethods());

app.use(serve(path.join(__dirname, '..', 'public')));

scheduler.start();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
============================================
自习室工位预约系统已启动
访问地址: http://localhost:${PORT}

学生端入口: /
老板端入口: /admin.html

默认管理员账号: admin / admin123
============================================
  `);
});

process.on('SIGINT', () => {
  scheduler.stop();
  process.exit(0);
});
