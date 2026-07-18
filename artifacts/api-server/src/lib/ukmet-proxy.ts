import { logger } from "./logger";

const B2C_TENANT = "dce84ec6-ce0f-45d1-ba16-e36b817081eb";
const B2C_POLICY = "B2C_1A_warrior_susi";
const CLIENT_ID = "2d406bea-fa37-434f-ad84-c9532a8dd1a4";
const B2C_HOST = "login.auth.metoffice.cloud";
const APP_HOST = "africawebviewer.metoffice.gov.uk";

interface TokenCache {
  authToken: string;
  refreshToken: string;
  expiresAt: number;
}

let tokenCache: TokenCache | null = null;

async function doLogin(): Promise<TokenCache> {
  const email = process.env.UKMET_EMAIL ?? "";
  const password = process.env.UKMET_PASS ?? "";

  if (!email || !password) {
    throw new Error("UKMET_EMAIL et UKMET_PASS requis");
  }

  const cookieJar: Record<string, string> = {};

  function parseCookies(headers: Headers, cookieJar: Record<string, string>): void {
    const raw = headers.getSetCookie?.() ?? [];
    for (const c of raw) {
      const [pair] = c.split(";");
      const eq = pair?.indexOf("=") ?? -1;
      if (eq > 0) {
        const name = pair?.slice(0, eq).trim() ?? "";
        const value = pair?.slice(eq + 1).trim() ?? "";
        if (name) cookieJar[name] = value;
      }
    }
  }

  function cookieHeader(jar: Record<string, string>): string {
    return Object.entries(jar)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }

  const authUrl =
    `https://${B2C_HOST}/${B2C_TENANT}/oauth2/v2.0/authorize` +
    `?p=${B2C_POLICY}` +
    `&response_type=code` +
    `&client_id=${CLIENT_ID}` +
    `&group_prefixes_filter=b2c%2Fafrica` +
    `&response_mode=form_post` +
    `&scope=openid%20offline_access` +
    `&redirect_uri=${encodeURIComponent(`https://${APP_HOST}/_callback`)}` +
    `&nonce=${Date.now()}` +
    `&state=%2F`;

  const step1 = await fetch(authUrl, {
    redirect: "follow",
    signal: AbortSignal.timeout(15000),
  });
  parseCookies(step1.headers, cookieJar);

  const html1 = await step1.text();
  const csrfMatch = html1.match(/"csrf":"([^"]+)"/);
  const transMatch = html1.match(/"transId":"([^"]+)"/);
  if (!csrfMatch || !transMatch) {
    throw new Error("UK Met B2C: impossible d'extraire csrf/transId");
  }
  const csrf = csrfMatch[1] ?? "";
  const transId = transMatch[1] ?? "";

  const postUrl =
    `https://${B2C_HOST}/${B2C_TENANT}/${B2C_POLICY}/SelfAsserted` +
    `?tx=${encodeURIComponent(transId)}&p=${B2C_POLICY}`;

  const selfParams = new URLSearchParams({
    request_type: "RESPONSE",
    signInName: email,
    password,
    rememberMe: "false",
  });

  const step2 = await fetch(postUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-CSRF-TOKEN": csrf,
      Cookie: cookieHeader(cookieJar),
      Referer: `https://${B2C_HOST}/`,
    },
    body: selfParams.toString(),
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
  });
  parseCookies(step2.headers, cookieJar);

  const selfJson = await step2.text();
  if (!selfJson.includes('"200"') && !selfJson.includes('"status":"200"')) {
    throw new Error(`UK Met B2C SelfAsserted: ${selfJson.slice(0, 200)}`);
  }

  const confirmUrl =
    `https://${B2C_HOST}/${B2C_TENANT}/${B2C_POLICY}/api/CombinedSigninAndSignup/confirmed` +
    `?rememberMe=false&csrf_token=${encodeURIComponent(csrf)}&tx=${encodeURIComponent(transId)}&p=${B2C_POLICY}`;

  const step3 = await fetch(confirmUrl, {
    headers: { Cookie: cookieHeader(cookieJar) },
    redirect: "follow",
    signal: AbortSignal.timeout(15000),
  });
  parseCookies(step3.headers, cookieJar);

  const html3 = await step3.text();
  const codeMatch = html3.match(/name=["']code["'][^>]*value=["']([^"']+)["']/);
  const stateMatch = html3.match(/name=["']state["'][^>]*value=["']([^"']+)["']/);
  const actionMatch = html3.match(/action=["']([^"']+)["']/);

  if (!codeMatch || !actionMatch) {
    throw new Error("UK Met B2C: code OAuth introuvable dans confirmed");
  }

  const code = codeMatch[1] ?? "";
  const state = stateMatch?.[1] ?? "/";
  const action = actionMatch[1] ?? `https://${APP_HOST}/_callback`;

  const cbParams = new URLSearchParams({ code, state });
  const step4 = await fetch(action, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookieHeader(cookieJar),
    },
    body: cbParams.toString(),
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
  });
  parseCookies(step4.headers, cookieJar);

  const step4Location = step4.headers.get("location") ?? "";
  const innerCallbackUrl = step4Location.startsWith("http")
    ? step4Location
    : `https://${APP_HOST}${step4Location}`;

  if (step4Location) {
    const step4b = await fetch(innerCallbackUrl, {
      headers: { Cookie: cookieHeader(cookieJar) },
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
    parseCookies(step4b.headers, cookieJar);

    const html4b = await step4b.text();
    if (html4b.includes("name=") && html4b.includes("code")) {
      const c2 = html4b.match(/name=["']code["'][^>]*value=["']([^"']+)["']/);
      const s2 = html4b.match(/name=["']state["'][^>]*value=["']([^"']+)["']/);
      const a2 = html4b.match(/action=["']([^"']+)["']/);
      if (c2 && a2) {
        const cb2Params = new URLSearchParams({ code: c2[1] ?? "", state: s2?.[1] ?? "/" });
        const step5 = await fetch(a2[1] ?? `https://${APP_HOST}/api/AfricaWebViewer/_callback`, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Cookie: cookieHeader(cookieJar),
          },
          body: cb2Params.toString(),
          redirect: "manual",
          signal: AbortSignal.timeout(15000),
        });
        parseCookies(step5.headers, cookieJar);
      }
    }
  }

  const authToken = cookieJar["AfricaWebViewer-auth_token"] ?? cookieJar["auth_token"];
  const refreshToken = cookieJar["refresh-AfricaWebViewer-auth_token"] ?? cookieJar["refresh-auth_token"] ?? "";

  if (!authToken) {
    throw new Error("UK Met: token introuvable après le login complet");
  }

  let expiresAt = Date.now() + 55 * 60 * 1000;
  try {
    const payload = JSON.parse(
      Buffer.from(authToken.split(".")[1]?.replace(/-/g, "+").replace(/_/g, "/") ?? "", "base64").toString()
    ) as { exp?: number };
    if (payload.exp) {
      expiresAt = payload.exp * 1000 - 60000;
    }
  } catch {
  }

  logger.info("UK Met: login réussi, token valide");
  return { authToken, refreshToken, expiresAt };
}

export async function getUkMetToken(): Promise<TokenCache> {
  const now = Date.now();
  if (tokenCache && now < tokenCache.expiresAt) {
    return tokenCache;
  }

  tokenCache = await doLogin();
  return tokenCache;
}

export function invalidateUkMetToken(): void {
  tokenCache = null;
}

export async function fetchUkMetImage(url: string): Promise<{ data: Buffer; contentType: string }> {
  const tokens = await getUkMetToken();

  const cookieStr = `AfricaWebViewer-auth_token=${tokens.authToken}; refresh-AfricaWebViewer-auth_token=${tokens.refreshToken}`;

  const res = await fetch(url, {
    headers: {
      Cookie: cookieStr,
      Referer: `https://${APP_HOST}/`,
    },
    signal: AbortSignal.timeout(20000),
  });

  if (res.status === 401 || res.status === 403) {
    invalidateUkMetToken();
    throw new Error(`UK Met: accès refusé (${res.status}) — token invalidé`);
  }

  if (!res.ok) {
    throw new Error(`UK Met: erreur HTTP ${res.status}`);
  }

  const ct = res.headers.get("content-type") ?? "image/png";
  const data = Buffer.from(await res.arrayBuffer());
  return { data, contentType: ct };
}
