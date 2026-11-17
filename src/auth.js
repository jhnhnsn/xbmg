import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadSession, saveSession } from './session.js';

const AUTHORITY = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';

/**
 * The client ID of the project's own Azure app registration. When it is set,
 * people can sign in without making their own registration. It is not a
 * secret: public clients have no secret. Empty means "ask for a client ID".
 */
export const DEFAULT_CLIENT_ID = '5605c70b-a1ff-42c9-9837-bf29342970d0';
const SCOPE = 'XboxLive.signin offline_access';

export class AuthError extends Error {}

const XSTS_ERRORS = {
  2148916233: 'This Microsoft account has no Xbox profile. Sign in once at https://www.xbox.com to create one.',
  2148916235: 'Xbox Live is not available in the country/region of this account.',
  2148916236: 'This account needs adult verification before it can use Xbox Live.',
  2148916237: 'This account needs adult verification before it can use Xbox Live.',
  2148916238: 'This is a child account. An adult must add it to a Microsoft family group first.',
};

async function postForm(url, params, signal) {
  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const body = await res.json().catch(() => ({}));
  return { res, body };
}

async function postXbox(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'x-xbl-contract-version': '1',
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    // Some XSTS errors come back with an empty or non-JSON body.
  }
  return { res, body };
}

function toMsToken(body, previousRefreshToken) {
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token || previousRefreshToken,
    expiresAt: Date.now() + (Number(body.expires_in || 3600) - 60) * 1000,
  };
}

/** A client ID is a GUID, for example 1a2b3c4d-1a2b-1a2b-1a2b-1a2b3c4d5e6f. */
export const CLIENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Turns a known sign-in error into advice. Returns null when there is none. */
export function authHint(message = '') {
  if (/AADSTS700016/.test(message)) {
    return 'Check the client ID. The app registration must allow "Personal Microsoft accounts".';
  }
  if (/AADSTS50011|redirect/i.test(message)) {
    return 'In the app registration, open Authentication and add the platform "Mobile and desktop applications" with the redirect URI http://localhost.';
  }
  if (/AADSTS7000218|AADSTS70002\b/.test(message)) {
    return 'In the app registration, open Authentication and set "Allow public client flows" to Yes.';
  }
  if (/authorization_declined|declined/i.test(message)) return 'You declined the sign-in. Try again to continue.';
  if (/expired_token|timed out/i.test(message)) return 'The code expired. Try again to get a new one.';
  return null;
}

/**
 * Interactive sign-in with the OAuth 2.0 device code flow. `print` gets the
 * message to show and { userCode, verificationUri, expiresIn }. Pass an
 * AbortSignal to cancel.
 */
export async function deviceCodeLogin(clientId, print, { signal } = {}) {
  const start = await postForm(`${AUTHORITY}/devicecode`, { client_id: clientId, scope: SCOPE }, signal);
  if (!start.res.ok) {
    throw new AuthError(
      `Could not start sign-in: ${start.body.error_description || start.body.error || `HTTP ${start.res.status}`}`,
    );
  }
  const { device_code: deviceCode, message, interval = 5, expires_in: expiresIn = 900 } = start.body;
  print(message, { userCode: start.body.user_code, verificationUri: start.body.verification_uri, expiresIn });

  let waitMs = interval * 1000;
  const deadline = Date.now() + expiresIn * 1000;
  while (Date.now() < deadline) {
    await sleep(waitMs, undefined, { signal });
    const { res, body } = await postForm(
      `${AUTHORITY}/token`,
      {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: clientId,
        device_code: deviceCode,
      },
      signal,
    );
    if (res.ok) return toMsToken(body);
    if (body.error === 'authorization_pending') continue;
    if (body.error === 'slow_down') {
      waitMs += 5000;
      continue;
    }
    throw new AuthError(`Sign-in failed: ${body.error_description || body.error || `HTTP ${res.status}`}`);
  }
  throw new AuthError('Sign-in timed out. Run "xbmg login" again.');
}

const b64url = (buf) => buf.toString('base64url');

function page(title, text) {
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  return `<!doctype html><meta charset="utf-8"><title>xbmg</title>
<style>body{font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;background:#111;color:#eee}
main{max-width:30em;padding:2em;text-align:center}h1{font-size:1.4em}p{color:#aaa}</style>
<main><h1>${esc(title)}</h1><p>${esc(text)}</p></main>`;
}

/**
 * Starts a one-time HTTP server on the loopback interface. Resolves `code`
 * when Microsoft redirects the browser back with a matching `state`.
 */
async function startLoopback(state) {
  let settle;
  const code = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  // A failure can come before anyone waits for the code. Callers still see the rejection.
  code.catch(() => {});
  const handler = (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const q = url.searchParams;
    if (!q.has('code') && !q.has('error')) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', connection: 'close' });
    if (q.get('state') !== state) {
      res.end(page('Sign-in link is out of date', 'Go back to the terminal and try again.'));
      return;
    }
    if (q.has('error')) {
      const detail = q.get('error_description') || q.get('error');
      res.end(page('Sign-in failed', detail));
      settle.reject(new AuthError(`Sign-in failed: ${detail}`));
      return;
    }
    res.end(page('You are signed in', 'You can close this tab and go back to the terminal.'));
    settle.resolve(q.get('code'));
  };
  const listen = (server, host, port) =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve(server.address().port));
    });
  // The browser can resolve "localhost" to IPv4 or IPv6, so listen on both loopback addresses.
  const v4 = createServer(handler);
  const port = await listen(v4, '127.0.0.1', 0);
  const v6 = createServer(handler);
  const servers = [v4];
  await listen(v6, '::1', port)
    .then(() => servers.push(v6))
    .catch(() => {});
  const close = () => {
    for (const s of servers) {
      s.close();
      s.closeAllConnections?.();
    }
  };
  return { port, code, close, fail: (e) => settle.reject(e) };
}

/**
 * Interactive sign-in in the web browser: OAuth 2.0 authorization code flow
 * with PKCE and a loopback redirect. `onUrl` gets the sign-in URL to open.
 * The app registration needs the redirect URI http://localhost
 * (platform "Mobile and desktop applications").
 */
export async function browserLogin(clientId, { onUrl, signal, timeoutMs = 10 * 60 * 1000 } = {}) {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(randomBytes(16));
  const loop = await startLoopback(state);
  const redirectUri = `http://localhost:${loop.port}`;
  const timer = setTimeout(() => loop.fail(new AuthError('Sign-in timed out. Try again.')), timeoutMs);
  const onAbort = () => loop.fail(Object.assign(new Error('Sign-in cancelled.'), { name: 'AbortError' }));
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal?.aborted) onAbort();
    const url = `${AUTHORITY}/authorize?${new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      response_mode: 'query',
      redirect_uri: redirectUri,
      scope: SCOPE,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      prompt: 'select_account',
    })}`;
    await onUrl?.(url);
    const code = await loop.code;
    const { res, body } = await postForm(
      `${AUTHORITY}/token`,
      {
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        scope: SCOPE,
      },
      signal,
    );
    if (!res.ok) {
      throw new AuthError(`Sign-in failed: ${body.error_description || body.error || `HTTP ${res.status}`}`);
    }
    return toMsToken(body);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    loop.close();
  }
}

/** True when a local browser probably cannot reach this machine's localhost, for example over SSH. */
export function preferDeviceCode(env = process.env) {
  return Boolean(env.SSH_CONNECTION || env.SSH_TTY);
}

export async function refreshMsToken(clientId, refreshToken) {
  const { res, body } = await postForm(`${AUTHORITY}/token`, {
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: refreshToken,
    scope: SCOPE,
  });
  if (!res.ok) {
    throw new AuthError(
      `Your sign-in expired. Run "xbmg login" again. (${body.error_description || body.error || `HTTP ${res.status}`})`,
    );
  }
  return toMsToken(body, refreshToken);
}

export async function xboxUserToken(msAccessToken) {
  const { res, body } = await postXbox('https://user.auth.xboxlive.com/user/authenticate', {
    Properties: {
      AuthMethod: 'RPS',
      SiteName: 'user.auth.xboxlive.com',
      RpsTicket: `d=${msAccessToken}`,
    },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT',
  });
  if (!res.ok || !body.Token) throw new AuthError(`Xbox user authentication failed (HTTP ${res.status}).`);
  return body.Token;
}

export async function xstsToken(userToken) {
  const { res, body } = await postXbox('https://xsts.auth.xboxlive.com/xsts/authorize', {
    Properties: { SandboxId: 'RETAIL', UserTokens: [userToken] },
    RelyingParty: 'http://xboxlive.com',
    TokenType: 'JWT',
  });
  if (!res.ok || !body.Token) {
    const known = XSTS_ERRORS[body.XErr];
    throw new AuthError(
      known || `Xbox authorization failed (HTTP ${res.status}${body.XErr ? `, XErr ${body.XErr}` : ''}).`,
    );
  }
  const claims = body.DisplayClaims?.xui?.[0] ?? {};
  return {
    token: body.Token,
    uhs: claims.uhs,
    xuid: claims.xid,
    gamertag: claims.gtg,
    expiresAt: Date.parse(body.NotAfter) - 5 * 60 * 1000,
  };
}

/**
 * Returns a valid XSTS token for the signed-in user, refreshing the
 * Microsoft and Xbox tokens when needed.
 */
export async function getXboxAuth({ force = false } = {}) {
  const session = await loadSession();
  if (!session?.clientId || !session?.ms?.refreshToken) {
    throw new AuthError('You are not signed in. Run "xbmg login" first.');
  }
  if (!force && session.xsts?.expiresAt > Date.now()) return session.xsts;

  if (force || !session.ms.accessToken || session.ms.expiresAt <= Date.now()) {
    session.ms = await refreshMsToken(session.clientId, session.ms.refreshToken);
    await saveSession(session);
  }
  session.xsts = await xstsToken(await xboxUserToken(session.ms.accessToken));
  await saveSession(session);
  return session.xsts;
}

export function authHeader(xsts) {
  return `XBL3.0 x=${xsts.uhs};${xsts.token}`;
}
