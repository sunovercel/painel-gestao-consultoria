// api/_auth.js — Sessão via Supabase Auth (fix 2026-10-01, substitui o esquema
// anterior de senha única E a primeira tentativa de Google OAuth próprio).
//
// Segue a MESMA linha de segurança do sr-gestao-gerencial (outro dashboard
// Suno já embutido no DataHub): o DataHub e os dashboards embutidos
// compartilham o MESMO projeto Supabase Auth (Google OAuth configurado
// dentro do Supabase, não em cada app). O client manda o access_token da
// sessão Supabase no header `Authorization: Bearer <token>`; aqui nunca
// decodificamos o JWT por conta própria -- validamos contra o endpoint
// /auth/v1/user do próprio Supabase (mesmo padrão de
// lib/auth/verify-user.ts do sr-gestao-gerencial).
//
// Variáveis de ambiente:
//   SUPABASE_URL         — URL do projeto Supabase (compartilhado com o DataHub)
//   SUPABASE_ANON_KEY     — anon key do mesmo projeto (pública por design)
//   ALLOWED_EMAIL_DOMAINS — domínios permitidos, separados por vírgula
//                           (default: suno.com.br,sunoresearch.com.br)

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

function bearerToken(req) {
  const header = req.headers['authorization'] || '';
  return header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
}

// Retorna { email, id } se o access_token do request for válido E de domínio
// permitido, senão null. Nunca lança -- qualquer erro de rede/parsing é
// tratado como "sem sessão" (fail-closed).
export async function verifySupabaseSession(req) {
  const token = bearerToken(req);
  if (!token) return null;

  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) return null; // config ausente -- nunca tratar como "sem gate"

  try {
    const res = await fetch(`${url}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: anon },
    });
    if (!res.ok) return null;
    const u = await res.json();
    if (!u?.email) return null;
    // Defesa em profundidade: mesmo que o Supabase aceite o token, só serve
    // dado do painel pra domínio corporativo Suno.
    if (!isAllowedEmail(u.email)) return null;
    return { email: u.email, id: u.id };
  } catch {
    return null;
  }
}

// Helper pra handlers de API (data.js/ask.js): aplica o gate e já responde
// 401 JSON quando não autenticado. Uso: `if (await requireSession(req, res)) return;`
// -- incondicional (não pula a checagem se alguma env var estiver ausente).
export async function requireSession(req, res) {
  const session = await verifySupabaseSession(req);
  if (!session) {
    res.status(401).json({ error: 'unauthorized' });
    return true; // "já respondi, pare aqui"
  }
  req.session = session;
  return false;
}
