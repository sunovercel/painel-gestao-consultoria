// api/auth/logout.js — encerra a sessão (limpa o cookie) e volta pro painel.
import { clearSessionCookie } from '../_auth.js';

export default async function handler(req, res) {
  clearSessionCookie(res);
  res.writeHead(302, { Location: '/' });
  res.end();
}
