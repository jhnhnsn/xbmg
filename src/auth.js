import { setTimeout as sleep } from 'node:timers/promises';
import { loadSession, saveSession } from './session.js';

const AUTHORITY = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
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
  if (/AADSTS7000218/.test(message)) {
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
