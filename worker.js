// TodoWeek - Cloudflare Worker
// KV bindings:
//   TODOWEEK_KV  … タスクデータ
//   SUBS_KV      … Push購読情報
//   UPDATE_KV    … アップデート履歴
// Environment Variables:
//   VAPID_PUBLIC_KEY   … VAPIDの公開鍵（Text）
//   VAPID_PRIVATE_KEY  … VAPIDの秘密鍵（Secret）
//   VAPID_SUBJECT      … mailto:メールアドレス（Text）

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const TOMB_TTL_MS = 30 * 86400000; // 削除済みタスク（墓標）の保持期間：30日

// タスクをIDごとに統合する（updatedAt が新しい方を採用。同時刻なら incoming を優先）
// updatedAt が無い旧データは 0 扱い。削除は {id, deleted:true, updatedAt} の墓標で表す。
// ※ script.js の mergeTasks と同じ規則。
function mergeTasks(stored, incoming) {
  const map = new Map();
  for (const t of stored)   if (t && t.id) map.set(t.id, t);
  for (const t of incoming) {
    if (!t || !t.id) continue;
    const cur = map.get(t.id);
    if (!cur || (t.updatedAt || 0) >= (cur.updatedAt || 0)) map.set(t.id, t);
  }
  const now = Date.now();
  return [...map.values()].filter(t => !(t.deleted && now - (t.updatedAt || 0) > TOMB_TTL_MS));
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url  = new URL(request.url);
    const path = url.pathname;

    // GET /ical-proxy?url=... … 外部カレンダー(ics/webcal)をCORS制約なしで取得するプロキシ
    if (path === '/ical-proxy' && request.method === 'GET') {
      let target = url.searchParams.get('url') || '';
      if (!target) return new Response('Bad Request: url required', { status: 400, headers: CORS });
      // webcal:// → https:// に変換
      if (target.startsWith('webcal://')) target = 'https://' + target.slice('webcal://'.length);
      if (!/^https?:\/\//.test(target)) return new Response('Bad Request: invalid url', { status: 400, headers: CORS });
      try {
        const res = await fetch(target, { headers: { 'User-Agent': 'TodoRemind/1.0' } });
        if (!res.ok) return new Response(`取得失敗: HTTP ${res.status}`, { status: 502, headers: CORS });
        const text = await res.text();
        // サイズ上限（5MB）。巨大なICSによる過負荷を防止
        if (text.length > 5 * 1024 * 1024) return new Response('ファイルサイズが大きすぎます', { status: 413, headers: CORS });
        return new Response(text, { headers: { ...CORS, 'Content-Type': 'text/calendar; charset=utf-8' } });
      } catch(e) {
        return new Response('取得エラー: ' + e.message, { status: 502, headers: CORS });
      }
    }

    // GET/PUT /imported-calendars/:userId … インポート済みカレンダーの設定（URL・名前・色）一覧
    const importedMatch = path.match(/^\/imported-calendars\/([a-zA-Z0-9_-]+)$/);
    if (importedMatch) {
      const userId = importedMatch[1];
      if (request.method === 'GET') {
        const data = await env.TODOWEEK_KV.get('importedCal_' + userId);
        return new Response(data || '[]', { headers: { ...CORS, 'Content-Type': 'application/json' } });
      }
      if (request.method === 'PUT') {
        const body = await request.text();
        try { JSON.parse(body); } catch { return new Response('Invalid JSON', { status: 400, headers: CORS }); }
        await env.TODOWEEK_KV.put('importedCal_' + userId, body);
        return new Response('OK', { headers: CORS });
      }
    }


    const taskMatch = path.match(/^\/tasks\/([a-zA-Z0-9_-]+)$/);
    if (taskMatch) {
      const userId = taskMatch[1];
      if (request.method === 'GET') {
        const data = await env.TODOWEEK_KV.get(userId);
        return new Response(data || '[]', {
          headers: { ...CORS, 'Content-Type': 'application/json' },
        });
      }
      if (request.method === 'PUT') {
        // 受け取った一覧を保存済みの一覧と統合して保存し、統合結果を返す
        const body = await request.text();
        let incoming;
        try { incoming = JSON.parse(body); } catch { return new Response('Invalid JSON', { status: 400, headers: CORS }); }
        if (!Array.isArray(incoming)) return new Response('Invalid JSON: array required', { status: 400, headers: CORS });
        let stored = [];
        try { stored = JSON.parse(await env.TODOWEEK_KV.get(userId) || '[]'); } catch {}
        if (!Array.isArray(stored)) stored = [];
        const merged = mergeTasks(stored, incoming);
        await env.TODOWEEK_KV.put(userId, JSON.stringify(merged));
        return new Response(JSON.stringify(merged), {
          headers: { ...CORS, 'Content-Type': 'application/json' },
        });
      }
    }

    // POST /subscribe/:userId
    const subMatch = path.match(/^\/subscribe\/([a-zA-Z0-9_-]+)$/);
    if (subMatch && request.method === 'POST') {
      const userId = subMatch[1];
      const body   = await request.text();
      try { JSON.parse(body); } catch { return new Response('Invalid JSON', { status: 400, headers: CORS }); }
      let subs = [];
      try { subs = JSON.parse(await env.SUBS_KV.get(userId) || '[]'); } catch {}
      const newSub = JSON.parse(body);
      if (!subs.find(s => s.endpoint === newSub.endpoint)) subs.push(newSub);
      await env.SUBS_KV.put(userId, JSON.stringify(subs));
      return new Response('OK', { headers: CORS });
    }

    // DELETE /subscribe/:userId
    if (subMatch && request.method === 'DELETE') {
      const userId = subMatch[1];
      const body   = await request.text();
      let subs = [];
      try { subs = JSON.parse(await env.SUBS_KV.get(userId) || '[]'); } catch {}
      try {
        const target = JSON.parse(body);
        subs = subs.filter(s => s.endpoint !== target.endpoint);
        await env.SUBS_KV.put(userId, JSON.stringify(subs));
      } catch {}
      return new Response('OK', { headers: CORS });
    }

    // GET /run-reminders  … Cronを手動実行（テスト用）
    if (path === '/run-reminders' && request.method === 'GET') {
      try {
        await sendReminders(env);
        return new Response('リマインド送信完了', { headers: CORS });
      } catch(e) {
        return new Response('エラー: ' + e.message, { headers: CORS });
      }
    }

    // GET /devices/:userId  … 登録済み端末一覧（endpointのみ返す）
    const devMatch = path.match(/^\/devices\/([a-zA-Z0-9_-]+)$/);
    if (devMatch && request.method === 'GET') {
      const userId = devMatch[1];
      let subs = [];
      try { subs = JSON.parse(await env.SUBS_KV.get(userId) || '[]'); } catch {}
      // endpointだけ返す（keysは秘密情報なので返さない）
      const safe = subs.map(s => ({ endpoint: s.endpoint }));
      return new Response(JSON.stringify(safe), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    // GET /vapidPublicKey
    if (path === '/vapidPublicKey' && request.method === 'GET') {
      return new Response(JSON.stringify({ key: env.VAPID_PUBLIC_KEY }), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    // GET /test-push/:userId
    const testMatch = path.match(/^\/test-push\/([a-zA-Z0-9_-]+)$/);
    if (testMatch && request.method === 'GET') {
      const userId = testMatch[1];
      const noBody = url.searchParams.get('nobody') === '1';
      let subs = [];
      try { subs = JSON.parse(await env.SUBS_KV.get(userId) || '[]'); } catch {}
      if (!subs.length) return new Response('購読情報なし', { headers: CORS });

      let results = [];
      for (const sub of subs) {
        try {
          if (noBody) {
            // ペイロードなし（暗号化なし）で送信
            const authHeader = await makeVapidHeader(
              sub.endpoint,
              env.VAPID_PUBLIC_KEY,
              env.VAPID_PRIVATE_KEY,
              env.VAPID_SUBJECT || 'mailto:admin@example.com'
            );
            const res = await fetch(sub.endpoint, {
              method: 'POST',
              headers: {
                'Authorization': authHeader,
                'TTL':           '86400',
                'Urgency':       'high',
              },
            });
            const txt = await res.text().catch(() => '');
            results.push((res.ok || res.status === 201 ? 'OK' : 'NG') + ` ${res.status}: ${txt}`);
          } else {
            const payload = JSON.stringify({
              title: '【テスト】TodoWeek通知',
              body:  'テスト通知です！正常に届いています 🎉',
              tag:   'test',
            });
            await sendPush(sub, payload, env);
            results.push('OK: ' + sub.endpoint.slice(0, 60));
          }
        } catch(e) {
          results.push('NG: ' + e.message + '\nendpoint: ' + sub.endpoint.slice(0, 60));
        }
      }
      return new Response(results.join('\n'), { headers: CORS });
    }

    // GET/PUT /favorites/:userId
    const favMatch = path.match(/^\/favorites\/([a-zA-Z0-9_-]+)$/);
    if (favMatch) {
      const userId = favMatch[1];
      if (request.method === 'GET') {
        const data = await env.TODOWEEK_KV.get('fav_' + userId);
        return new Response(data || '[]', {
          headers: { ...CORS, 'Content-Type': 'application/json' },
        });
      }
      if (request.method === 'PUT') {
        const body = await request.text();
        try { JSON.parse(body); } catch { return new Response('Invalid JSON', { status: 400, headers: CORS }); }
        await env.TODOWEEK_KV.put('fav_' + userId, body);
        return new Response('OK', { headers: CORS });
      }
    }

    // GET/PUT /subject-settings/:userId
    const subjectMatch = path.match(/^\/subject-settings\/([a-zA-Z0-9_-]+)$/);
    if (subjectMatch) {
      const userId = subjectMatch[1];
      if (request.method === 'GET') {
        const data = await env.TODOWEEK_KV.get('subjectSettings_' + userId);
        return new Response(data || '{}', { headers: { ...CORS, 'Content-Type': 'application/json' } });
      }
      if (request.method === 'PUT') {
        const body = await request.text();
        try { JSON.parse(body); } catch { return new Response('Invalid JSON', { status: 400, headers: CORS }); }
        await env.TODOWEEK_KV.put('subjectSettings_' + userId, body);
        return new Response('OK', { headers: CORS });
      }
    }

    // GET /update-history/:userId  POST /update-history/:userId
    const historyMatch = path.match(/^\/update-history\/([a-zA-Z0-9_-]+)$/);
    if (historyMatch) {
      const userId = historyMatch[1];
      if (request.method === 'GET') {
        const data = await env.UPDATE_KV.get('updateHistory_' + userId);
        return new Response(data || '{}', { headers: { ...CORS, 'Content-Type': 'application/json' } });
      }
      if (request.method === 'POST') {
        const { deviceId, timestamp } = await request.json();
        if (!deviceId || !timestamp) return new Response('Bad Request', { status: 400, headers: CORS });
        const raw  = await env.UPDATE_KV.get('updateHistory_' + userId);
        const hist = raw ? JSON.parse(raw) : {};
        if (!Array.isArray(hist[deviceId])) hist[deviceId] = [];
        hist[deviceId].unshift(timestamp);
        if (hist[deviceId].length > 20) hist[deviceId] = hist[deviceId].slice(0, 20);
        await env.UPDATE_KV.put('updateHistory_' + userId, JSON.stringify(hist));
        return new Response('OK', { headers: CORS });
      }
    }

    return new Response('Not found', { status: 404, headers: CORS });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendReminders(env));
  },
};

// ─────────────────────────────────────────
// リマインド送信
// ─────────────────────────────────────────
async function sendReminders(env) {
  const now    = new Date();
  const jstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);

  // 現在のJST日付・時刻（5分単位に丸める）
  const todayStr    = jstNow.toISOString().slice(0, 10);
  const currentHH   = String(jstNow.getUTCHours()).padStart(2, '0');
  const currentMM   = String(Math.floor(jstNow.getUTCMinutes() / 5) * 5).padStart(2, '0');
  const currentTime = `${currentHH}:${currentMM}`; // 例: "07:00"

  const subsList = await env.SUBS_KV.list();
  if (!subsList.keys.length) return;

  for (const key of subsList.keys) {
    const userId = key.name;
    let subs = [];
    try { subs = JSON.parse(await env.SUBS_KV.get(userId) || '[]'); } catch { continue; }
    if (!subs.length) continue;

    let tasks = [];
    try { tasks = JSON.parse(await env.TODOWEEK_KV.get(userId) || '[]'); } catch { continue; }

    // notifications配列（新形式）/ notifTimes文字列配列（旧形式）/ notifTime単一（最旧）を正規化
    const remindedTasks = [];
    for (const t of tasks) {
      if (t.deleted || t.done || !t.date) continue; // 削除済み（墓標）・完了済みは通知しない

      let notifs = [];
      if (Array.isArray(t.notifications) && t.notifications.length) {
        // noneを除外、dateタイプも含める
        notifs = t.notifications.filter(n => n && n.remind !== 'none');
      } else if (Array.isArray(t.notifTimes) && t.notifTimes.length) {
        const r = t.remind && t.remind !== '0' ? t.remind : 'today';
        notifs = t.notifTimes.filter(s => s && s !== 'none').map(s => ({ remind: r, time: s }));
      } else if (t.notifTime && t.notifTime !== 'none') {
        const r = t.remind && t.remind !== '0' ? t.remind : 'today';
        notifs = [{ remind: r, time: t.notifTime }];
      }

      for (const notif of notifs) {
        if (notif.time !== currentTime) continue;
        const nr = notif.remind || 'today';
        if (nr === '0' || nr === 'none') continue;

        let remindStr;
        if (nr === 'date') {
          // 日付指定: notif.date が直接リマインド日
          remindStr = notif.date || null;
        } else if (nr === 'today') {
          remindStr = t.date;
        } else {
          const [y, m, d] = t.date.split('-').map(Number);
          const remindMs = Date.UTC(y, m - 1, d) - parseInt(nr, 10) * 86400000;
          const rd = new Date(remindMs);
          remindStr = `${rd.getUTCFullYear()}-${String(rd.getUTCMonth()+1).padStart(2,'0')}-${String(rd.getUTCDate()).padStart(2,'0')}`;
        }
        if (remindStr && remindStr === todayStr) { remindedTasks.push(t); break; }
      }
    }

    for (const task of remindedTasks) {
      const [ty, tm, td] = task.date.split('-').map(Number);
      const [oy, om, od] = todayStr.split('-').map(Number);
      const diffDays  = Math.round((Date.UTC(ty,tm-1,td) - Date.UTC(oy,om-1,od)) / 86400000);
      const dayText   = diffDays > 0  ? `まであと${diffDays}日です`
                      : diffDays === 0 ? `は今日です`
                      : `から${Math.abs(diffDays)}日過ぎています`;
      const taskLabel = (task.subject && task.subject !== 'なし')
        ? `${task.subject}　${task.title}`
        : task.title;
      const payload   = JSON.stringify({
        title: '【リマインド】設定されたTODOが近づいています',
        body:  `「${taskLabel}」${dayText}`,
        tag:   'remind-' + task.id,
      });
      for (const sub of subs) {
        try { await sendPush(sub, payload, env); } catch(e) { console.error(e); }
      }
    }
  }
}

// ─────────────────────────────────────────
// Web Push 送信（メイン）
// ─────────────────────────────────────────
async function sendPush(subscription, payloadStr, env) {
  const { endpoint, keys } = subscription;
  const { p256dh, auth }   = keys;

  // 1. ペイロードを暗号化
  const encrypted = await encrypt(payloadStr, p256dh, auth);

  // 2. VAPIDヘッダーを生成
  const authHeader = await makeVapidHeader(
    endpoint,
    env.VAPID_PUBLIC_KEY,
    env.VAPID_PRIVATE_KEY,
    env.VAPID_SUBJECT || 'mailto:admin@example.com'
  );

  // 3. 送信
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization':    authHeader,
      'Content-Type':     'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL':              '86400',
      'Topic':            'todoweek-remind',
      'Urgency':          'normal',
    },
    body: encrypted,
  });

  if (!res.ok && res.status !== 201) {
    const body = await res.text().catch(() => '');
    throw new Error(`Push failed: ${res.status} ${body}`);
  }
}

// ─────────────────────────────────────────
// VAPID JWT 生成
// ─────────────────────────────────────────
async function makeVapidHeader(endpoint, pubKeyB64, privKeyB64, subject) {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 43200;

  const enc        = new TextEncoder();
  const headerB64  = base64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payloadB64 = base64url(enc.encode(JSON.stringify({
    aud: 'https://web.push.apple.com',
    exp: exp,
    iat: now,
    sub: subject,
  })));
  const unsigned = `${headerB64}.${payloadB64}`;

  // 公開鍵からx, y を取り出す
  const pubBytes = b64urlToBytes(pubKeyB64);
  const x = base64url(pubBytes.slice(1, 33));
  const y = base64url(pubBytes.slice(33, 65));

  // 秘密鍵をraw bytes(32バイト)として取得
  const dBytes = b64urlToBytes(privKeyB64);

  // PKCS8 DER を手動で構築
  // ECPrivateKey (RFC 5915) を PKCS8 (RFC 5958) でラップ
  const oidEC      = new Uint8Array([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01]);         // OID ecPublicKey
  const oidP256    = new Uint8Array([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07]);   // OID P-256
  const pubPoint   = pubBytes; // 65バイト uncompressed

  // ECPrivateKey ::= SEQUENCE { version INTEGER, privateKey OCTET STRING, publicKey [1] BIT STRING }
  const ecPrivSeq  = buildDer(0x30, concat(
    buildDer(0x02, new Uint8Array([0x01])),                        // version = 1
    buildDer(0x04, dBytes),                                        // privateKey
    buildDer(0xa1, buildDer(0x03, concat(new Uint8Array([0x00]), pubPoint))) // publicKey
  ));

  // AlgorithmIdentifier ::= SEQUENCE { algorithm OID, parameters OID }
  const algId = buildDer(0x30, concat(
    buildDer(0x06, oidEC),
    buildDer(0x06, oidP256)
  ));

  // PrivateKeyInfo ::= SEQUENCE { version INTEGER, algorithm AlgorithmIdentifier, privateKey OCTET STRING }
  const pkcs8 = buildDer(0x30, concat(
    buildDer(0x02, new Uint8Array([0x00])),  // version = 0
    algId,
    buildDer(0x04, ecPrivSeq)
  ));

  const key = await crypto.subtle.importKey(
    'pkcs8', pkcs8.buffer,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false, ['sign']
  );

  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: { name: 'SHA-256' } },
    key,
    enc.encode(unsigned)
  );
  const jwt = `${unsigned}.${base64url(new Uint8Array(sig))}`;

  return `vapid t=${jwt}, k=${pubKeyB64}`;
}

// DER TLV ビルダー
function buildDer(tag, value) {
  const len = value.length;
  let lenBytes;
  if (len < 0x80) {
    lenBytes = new Uint8Array([len]);
  } else if (len < 0x100) {
    lenBytes = new Uint8Array([0x81, len]);
  } else {
    lenBytes = new Uint8Array([0x82, (len >> 8) & 0xff, len & 0xff]);
  }
  return concat(new Uint8Array([tag]), lenBytes, value);
}

function concat(...arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out   = new Uint8Array(total);
  let offset  = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}

// ─────────────────────────────────────────
// ペイロード暗号化（RFC 8188 aes128gcm）
// ─────────────────────────────────────────
async function encrypt(payloadStr, p256dhB64, authB64) {
  const enc         = new TextEncoder();
  const plaintext   = enc.encode(payloadStr);
  const clientPubRaw = b64urlToBytes(p256dhB64);
  const authSecret   = b64urlToBytes(authB64);

  // サーバー鍵ペア生成
  const serverKeyPair = /** @type {CryptoKeyPair} */ (await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']
  ));
  const serverPubRaw = new Uint8Array(
    await crypto.subtle.exportKey('raw', serverKeyPair.publicKey)
  );

  // クライアント公開鍵インポート
  const clientPubKey = await crypto.subtle.importKey(
    'raw', clientPubRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []
  );

  // ECDH共有秘密
  const sharedBits = new Uint8Array(
    await crypto.subtle.deriveBits(
      /** @type {any} */ ({ name: 'ECDH', public: clientPubKey }),
      serverKeyPair.privateKey, 256
    )
  );

  // salt（16バイト）
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // RFC 8291: HKDF
  // Step1: PRK_key = HKDF-Extract(auth_secret, ecdh_secret)
  const prkKey = await hkdfExtract(authSecret, sharedBits);

  // Step2: key_info = "WebPush: info\0" + clientPub + serverPub
  const keyInfoLabel = new TextEncoder().encode('WebPush: info\x00');
  const keyInfo = new Uint8Array(keyInfoLabel.length + clientPubRaw.length + serverPubRaw.length);
  keyInfo.set(keyInfoLabel);
  keyInfo.set(clientPubRaw, keyInfoLabel.length);
  keyInfo.set(serverPubRaw, keyInfoLabel.length + clientPubRaw.length);

  // Step3: IKM = HKDF-Expand(PRK_key, key_info, 32)
  const ikm = await hkdfExpand(prkKey, keyInfo, 32);

  // Step4: PRK = HKDF-Extract(salt, IKM)
  const prk = await hkdfExtract(salt, ikm);

  // Step5: CEK = HKDF-Expand(PRK, "Content-Encoding: aes128gcm\0", 16)
  // Step6: NONCE = HKDF-Expand(PRK, "Content-Encoding: nonce\0", 12)
  const cekInfo   = new TextEncoder().encode('Content-Encoding: aes128gcm\x00');
  const nonceInfo = new TextEncoder().encode('Content-Encoding: nonce\x00');
  const contentKey = await hkdfExpand(prk, cekInfo,   16);
  const nonce      = await hkdfExpand(prk, nonceInfo, 12);

  // AES-GCM 暗号化
  // RFC 8188: plaintext の末尾に \x02 (delimiter) を追加する
  const paddedPlaintext = new Uint8Array(plaintext.length + 1);
  paddedPlaintext.set(plaintext);
  paddedPlaintext[plaintext.length] = 0x02; // delimiter octet

  const aesKey = await crypto.subtle.importKey(
    'raw', contentKey, { name: 'AES-GCM' }, false, ['encrypt']
  );
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, paddedPlaintext)
  );

  // aes128gcm レコードヘッダー（salt 16 + rs 4 + keyid_len 1 + serverPub 65）
  const rs     = 4096;
  const header = new Uint8Array(21 + serverPubRaw.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, rs, false);
  header[20] = serverPubRaw.length;
  header.set(serverPubRaw, 21);

  const result = new Uint8Array(header.length + ciphertext.length);
  result.set(header);
  result.set(ciphertext, header.length);
  return result;
}

async function hkdfExtract(salt, ikm) {
  const saltKey = await crypto.subtle.importKey(
    'raw', salt.buffer ?? salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', saltKey, ikm.buffer ?? ikm));
}

async function hkdfExpand(prk, info, length) {
  const prkKey = await crypto.subtle.importKey(
    'raw', prk.buffer ?? prk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const data = new Uint8Array(info.length + 1);
  data.set(info);
  data[info.length] = 1;
  const okm = new Uint8Array(await crypto.subtle.sign('HMAC', prkKey, data.buffer));
  return okm.slice(0, length);
}

// ─────────────────────────────────────────
// Base64url ユーティリティ
// ─────────────────────────────────────────
function b64urlToBytes(str) {
  const s = str.trim().replace(/-/g, '+').replace(/_/g, '/');
  const p = s.padEnd(s.length + (4 - s.length % 4) % 4, '=');
  const b = atob(p);
  return Uint8Array.from(b, c => c.charCodeAt(0));
}

function base64url(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}