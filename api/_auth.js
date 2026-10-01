// api/_auth.js — Sessão de login (Google SSO corporativo), compartilhada
// por api/data.js, api/ask.js e api/auth/*.
//
// Substitui o esquema antigo de senha única (SITE_PASSWORD/x-site-password).
// Sessão própria (sem next-auth -- o painel não é Next.js, ver CLAUDE.md):
// cookie "session" = payload base64url + assinatura HMAC-SHA256 (AUTH_SECRET).
// SameSite=None;Secure é obrigatório -- o painel roda embutido em iframe
// cross-site dentro do Suno DataHub (datahub.suno.com.br), e cookies
// SameSite=Lax/Strict não seriam enviados nesse contexto.
//
// Variáveis de ambiente:
//   AUTH_SECRET            — segredo de assinatura (openssl rand -base64 32)
//   ALLOWED_EMAIL_DOMAINS  — domínios permitidos, separados por vírgula
//                            (default: suno.com.br,sunoresearch.com.br)

import crypto from 'crypto';

const SESSION_COOKIE = 'session';
const SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 7; // 7 dias

const ALLOWED_DOMAINS = (
  process.env.ALLOWED_EMAIL_DOMAINS || 'suno.com.br,sunoresearch.com.br'
)
  .split(',')
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

export function isAllowedEmail(email) {
  if (!email) return false;
  const normalized = String(email).trim().toLowerCase();
  const at = normalized.lastIndexOf('@');
  if (at === -1) return false;
  const domain = normalized.slice(at + 1);
  // Comparação exata de domínio -- nunca endsWith (evita "evil-suno.com.br").
  return ALLOWED_DOMAINS.includes(domain);
}

function authSecret() {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error('AUTH_SECRET não configurada no servidor.');
  return secret;
}

function sign(payload) {
  return crypto.createHmac('sha256', authSecret()).update(payload).digest('base64url');
}

// Parser de cookie simples -- sem dependência nova (projeto é intencionalmente
// sem framework/build, ver CLAUDE.md).
export function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i === -1) return;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

const useSecureCookies = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;

function cookieFlags(maxAgeSec) {
  const parts = ['Path=/', 'HttpOnly', `Max-Age=${maxAgeSec}`];
  // SameSite=None exige Secure (regra do próprio spec) -- em dev local (http)
  // cai pra Lax, senão o navegador recusa o cookie inteiro.
  if (useSecureCookies) parts.push('SameSite=None', 'Secure');
  else parts.push('SameSite=Lax');
  return parts.join('; ');
}

export function signSession(email) {
  const exp = Date.now() + SESSION_MAX_AGE_SEC * 1000;
  const payload = Buffer.from(JSON.stringify({ email, exp })).toString('base64url');
  const sig = sign(payload);
  return `${payload}.${sig}`;
}

// Retorna a string do header Set-Cookie (não aplica no response) -- quem
// precisa setar essa cookie JUNTO com outras (ex.: limpando as temporárias
// do fluxo OAuth no mesmo response) monta um array e chama res.setHeader
// uma vez só (setHeader com array substitui, não concatena, chamadas
// separadas sobrescreveriam uma à outra).
export function sessionCookieString(email) {
  const token = signSession(email);
  return `${SESSION_COOKIE}=${token}; ${cookieFlags(SESSION_MAX_AGE_SEC)}`;
}

export function setSessionCookie(res, email) {
  res.setHeader('Set-Cookie', sessionCookieString(email));
}

export function clearSessionCookieString() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Max-Age=0${useSecureCookies ? '; SameSite=None; Secure' : '; SameSite=Lax'}`;
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', clearSessionCookieString());
}

// Retorna { email } se a sessão do request for válida, senão null.
// Nunca lança -- qualquer cookie malformado/adulterado/expirado é tratado
// como "sem sessão" (fail-closed por natureza: ausência de retorno válido
// sempre significa 401 em quem chama, nunca um bypass silencioso).
export function verifySession(req) {
  try {
    const cookies = parseCookies(req);
    const token = cookies[SESSION_COOKIE];
    if (!token) return null;
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return null;
    const expected = sign(payload);
    // Comparação em tempo constante -- evita timing attack na assinatura.
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.email || !data.exp || Date.now() > data.exp) return null;
    if (!isAllowedEmail(data.email)) return null; // defesa em profundidade -- domínio revalidado a cada request
    return { email: data.email };
  } catch {
    return null;
  }
}

// Helper pra handlers de API (data.js/ask.js): aplica o gate e já responde
// 401 JSON quando não autenticado. Uso: `if (requireSession(req, res)) return;`
// -- NÃO é condicional a nenhuma env var estar setada (fail-closed; o esquema
// antigo de SITE_PASSWORD pulava o gate inteiro se a env var estivesse vazia).
export function requireSession(req, res) {
  const session = verifySession(req);
  if (!session) {
    res.status(401).json({ error: 'unauthorized' });
    return true; // "já respondi, pare aqui"
  }
  req.session = session;
  return false;
}
