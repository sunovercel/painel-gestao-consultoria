// api/auth/callback.js — recebe o retorno do Google, troca o código por
// tokens, valida o id_token (assinatura + domínio corporativo) e abre sessão.
//
// Usa google-auth-library (OAuth2Client) pra troca de código e verificação
// do id_token -- mesma lib que a referência (suno-Hora-Hora-dashboard, via
// Auth.js) usa por baixo; não reinventa verificação de JWT/assinatura.

import { OAuth2Client } from 'google-auth-library';
import { parseCookies, sessionCookieString, isAllowedEmail } from '../_auth.js';

function baseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

function safeCallbackPath(raw) {
  if (typeof raw !== 'string') return '/';
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/';
  return raw;
}

const useSecureCookies = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
function expiredShortCookieStrings() {
  const flags = `Path=/; HttpOnly; Max-Age=0${useSecureCookies ? '; SameSite=Lax; Secure' : '; SameSite=Lax'}`;
  return [`oauth_state=; ${flags}`, `oauth_cb=; ${flags}`];
}

export default async function handler(req, res) {
  const origin = baseUrl(req);
  const clientId = process.env.AUTH_GOOGLE_ID;
  const clientSecret = process.env.AUTH_GOOGLE_SECRET;

  if (!clientId || !clientSecret) {
    res.status(500).json({ error: 'AUTH_GOOGLE_ID/AUTH_GOOGLE_SECRET não configuradas no servidor.' });
    return;
  }

  const cookies = parseCookies(req);
  const { code, state, error: googleError } = req.query;

  const fail = (reason) => {
    res.setHeader('Set-Cookie', expiredShortCookieStrings());
    res.writeHead(302, { Location: `${origin}/?error=${encodeURIComponent(reason)}` });
    res.end();
  };

  if (googleError) return fail('AccessDenied');
  if (!code || !state) return fail('Configuration');
  // Anti-CSRF: o state devolvido pelo Google tem que bater com o que
  // guardamos no cookie no início do fluxo (api/auth/login.js).
  if (!cookies.oauth_state || cookies.oauth_state !== state) return fail('Configuration');

  const callbackUrl = safeCallbackPath(
    cookies.oauth_cb ? decodeURIComponent(cookies.oauth_cb) : '/'
  );

  try {
    const redirectUri = `${origin}/api/auth/callback`;
    const client = new OAuth2Client(clientId, clientSecret, redirectUri);
    const { tokens } = await client.getToken(code);

    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: clientId,
    });
    const payload = ticket.getPayload();

    const emailVerified = payload?.email_verified === true;
    const email = payload?.email;

    if (!email || !emailVerified) return fail('AccessDenied');
    if (!isAllowedEmail(email)) return fail('AccessDenied');

    // Um único Set-Cookie (array) -- setHeader substitui, não concatena;
    // chamar separadamente pra cada cookie perderia os anteriores.
    res.setHeader('Set-Cookie', [...expiredShortCookieStrings(), sessionCookieString(email)]);
    res.writeHead(302, { Location: `${origin}${callbackUrl}` });
    res.end();
  } catch (e) {
    res.setHeader('Set-Cookie', expiredShortCookieStrings());
    res.writeHead(302, { Location: `${origin}/?error=${encodeURIComponent('Configuration')}` });
    res.end();
  }
}
