// api/auth/login.js — inicia o fluxo OAuth2 (Authorization Code) com o Google.
// Gera um `state` (anti-CSRF) e guarda ele + o callbackUrl em cookies curtos,
// depois redireciona pro endpoint de autorização do Google.
//
// Variáveis de ambiente: AUTH_GOOGLE_ID, (opcional) PUBLIC_BASE_URL.

import crypto from 'crypto';

const useSecureCookies = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
const SHORT_COOKIE_MAX_AGE = 600; // 10 min -- tempo de vida do fluxo de login

function shortCookieFlags() {
  const parts = ['Path=/', 'HttpOnly', `Max-Age=${SHORT_COOKIE_MAX_AGE}`];
  if (useSecureCookies) parts.push('SameSite=Lax', 'Secure');
  else parts.push('SameSite=Lax');
  return parts.join('; ');
}

// Só aceita caminho relativo (começa com "/", nunca "//" -- evita open redirect
// via protocol-relative URL tipo "//evil.com").
function safeCallbackPath(raw) {
  if (typeof raw !== 'string') return '/';
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/';
  return raw;
}

function baseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

export default async function handler(req, res) {
  const clientId = process.env.AUTH_GOOGLE_ID;
  if (!clientId) {
    res.status(500).json({ error: 'AUTH_GOOGLE_ID não configurada no servidor.' });
    return;
  }

  const callbackUrl = safeCallbackPath(req.query.callbackUrl);
  const state = crypto.randomBytes(24).toString('base64url');
  const origin = baseUrl(req);
  const redirectUri = `${origin}/api/auth/callback`;

  res.setHeader('Set-Cookie', [
    `oauth_state=${state}; ${shortCookieFlags()}`,
    `oauth_cb=${encodeURIComponent(callbackUrl)}; ${shortCookieFlags()}`,
  ]);

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'openid email profile');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('prompt', 'select_account');
  // 'hd' é só dica de UX pro Google pré-filtrar contas na tela -- a validação
  // real de domínio acontece no callback, contra o e-mail verificado.

  res.writeHead(302, { Location: authUrl.toString() });
  res.end();
}
