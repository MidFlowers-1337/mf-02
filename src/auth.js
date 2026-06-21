const jwt = require('jsonwebtoken');

const JWT_SECRET = 'study-room-secret-key-change-in-production';

function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function authMiddleware(ctx, next) {
  const authHeader = ctx.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    ctx.status = 401;
    ctx.body = { error: '未登录' };
    return;
  }
  const token = authHeader.slice(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    ctx.state.user = decoded;
    return next();
  } catch (err) {
    ctx.status = 401;
    ctx.body = { error: '登录已过期' };
  }
}

function adminMiddleware(ctx, next) {
  if (!ctx.state.user || ctx.state.user.role !== 'admin') {
    ctx.status = 403;
    ctx.body = { error: '需要管理员权限' };
    return;
  }
  return next();
}

module.exports = { signToken, authMiddleware, adminMiddleware, JWT_SECRET };
