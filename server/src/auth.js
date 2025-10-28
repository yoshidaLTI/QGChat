import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";

const {
  JWT_SECRET,
  COOKIE_NAME = "auth",
  COOKIE_SECURE = "false",
  COOKIE_SAMESITE = "lax",
  COOKIE_MAX_DAYS = "7"
} = process.env;

export const cookies = cookieParser();

export function signToken(payload) {
  const days = Number(COOKIE_MAX_DAYS) || 7;
  return jwt.sign(payload, JWT_SECRET, { expiresIn: `${days}d` });
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

export function setAuthCookie(res, token) {
  const secure = String(COOKIE_SECURE) === "true";
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure,
    sameSite: COOKIE_SAMESITE,
    maxAge: (Number(COOKIE_MAX_DAYS) || 7) * 24 * 60 * 60 * 1000,
    path: "/"
  });
}

export function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: "/" });
}

export function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  const payload = token ? verifyToken(token) : null;
  if (!payload?.sub) return res.status(401).json({ error: "unauthorized" });
  req.user = { id: payload.sub, username: payload.username };
  next();
}

