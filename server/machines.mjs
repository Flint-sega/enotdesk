import crypto from 'node:crypto';
import { hashPassword, verifyPassword, verifyPasswordAsync, newToken, sha256 } from './crypto.mjs';

// Машины (unattended): onboarding-коды, группы строкой, PIN.
// Наружу отдаются только sanitized-объекты (out): PIN, токен агента и
// onboarding-код хранятся в БД ТОЛЬКО хешами и не покидают модуль.
// Одноразовый код агент меняет на токен машины (register); токен живёт,
// пока машину не отзовут; heartbeat агента отмечается через touch.

// срок жизни onboarding-кода — как у приглашений людей
const ONBOARDING_TTL_MS = 24 * 3600 * 1000;
// агент подтверждает жизнь heartbeat-ом (как host, раз в ~5с); окно online — с запасом
const ONLINE_WINDOW_MS = 60 * 1000;

// Инвентарь машины (R06): агент присылает объект с heartbeat'ом, наружу
// проходит только allowlist полей с жёсткими пределами. Мусор любого рода —
// не-объект, не-те типы, переполнение 4 КБ — отбрасывается (null): сервер не
// хранит то, что не смог понять. Где поле собрать не удалось (например, statfs
// недоступен) — оно просто отсутствует, фейков агент не присылает и мы не делаем.
const INVENTORY_LIMITS = { str: 60, bytes: 4096, uptimeSecMax: 1e12, diskFreeGbMax: 1e9 };

export function sanitizeInventory(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  if (JSON.stringify(value).length > INVENTORY_LIMITS.bytes) return null;
  const inv = {};
  for (const key of ['os', 'appVersion']) {
    const v = value[key];
    if (typeof v === 'string' && v.trim()) inv[key] = v.trim().slice(0, INVENTORY_LIMITS.str);
  }
  for (const [key, max] of [['uptimeSec', INVENTORY_LIMITS.uptimeSecMax], ['diskFreeGb', INVENTORY_LIMITS.diskFreeGbMax]]) {
    const n = value[key];
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= max) {
      inv[key] = key === 'uptimeSec' ? Math.floor(n) : Math.round(n * 100) / 100;
    }
  }
  return Object.keys(inv).length ? inv : null;
}

// Инвентарь из БД: писали только после валидации, но читаем на отказ честно.
function storedInventory(raw) {
  try {
    const v = JSON.parse(raw || 'null');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

export function createMachinesStore(db, { nowMs = Date.now, onlineWindowMs = ONLINE_WINDOW_MS } = {}) {
  const nowIso = () => new Date(nowMs()).toISOString();
  const get = (id) => db.prepare('SELECT * FROM machines WHERE id = ?').get(id) || null;

  // наружное представление машины: никаких хешей и секретов
  function out(row) {
    if (!row) return null;
    const seen = row.last_seen_at ? Date.parse(row.last_seen_at) : NaN;
    return {
      id: row.id,
      name: row.name,
      groupName: row.group_name,
      os: row.os,
      agentVersion: row.agent_version,
      tags: JSON.parse(row.tags || '[]'),
      hasPin: row.pin_hash != null,
      registered: row.agent_token_hash != null,
      revokedAt: row.revoked_at,
      lastSeenAt: row.last_seen_at,
      inventory: storedInventory(row.inventory),
      online: !Number.isNaN(seen) && nowMs() - seen <= onlineWindowMs,
      onboardingExpiresAt: row.onboarding_expires_at,
      onboardingUsedAt: row.onboarding_used_at,
      createdBy: row.created_by,
      createdAt: row.created_at,
    };
  }

  return {
    out,
    get,

    list({ limit = 50, offset = 0 } = {}) {
      const items = db.prepare(
        'SELECT * FROM machines ORDER BY created_at, id LIMIT ? OFFSET ?'
      ).all(limit, offset).map(out);
      const total = db.prepare('SELECT count(*) c FROM machines').get().c;
      return { items, total };
    },

    // Одноразовый onboarding-код: открытый текст возвращается один раз,
    // в БД — только sha256.
    createOnboarding({ name, groupName = '', createdBy = null }, { ttlMs = ONBOARDING_TTL_MS } = {}) {
      const id = crypto.randomUUID();
      const code = newToken();
      const expiresAt = new Date(nowMs() + ttlMs).toISOString();
      db.prepare(`INSERT INTO machines (id, name, group_name, onboarding_code_hash, onboarding_expires_at, tags, created_by, created_at)
                  VALUES (?,?,?,?,?,'[]',?,?)`)
        .run(id, name, groupName, sha256(code), expiresAt, createdBy, nowIso());
      return { machine: out(get(id)), code, expiresAt };
    },

    // Обмен кода на токен машины. null — код неизвестен, погашен, отозван или просрочен.
    register({ code, name, os = '', version = '' }) {
      if (typeof code !== 'string' || !code) return null;
      const row = db.prepare('SELECT * FROM machines WHERE onboarding_code_hash = ?').get(sha256(code));
      if (!row || row.onboarding_used_at || row.revoked_at) return null;
      if (Date.parse(row.onboarding_expires_at) <= nowMs()) return null;
      const token = newToken();
      // атомарное погашение кода: двойная регистрация и гонка невозможны
      const r = db.prepare(`UPDATE machines
                            SET name=?, os=?, agent_version=?, agent_token_hash=?, onboarding_used_at=?, onboarding_code_hash=NULL
                            WHERE id=? AND onboarding_code_hash IS NOT NULL AND onboarding_used_at IS NULL`)
        .run(String(name), String(os), String(version), sha256(token), nowIso(), row.id);
      if (r.changes !== 1) return null;
      return { machine: out(get(row.id)), token };
    },

    // Отзыв: токен агента и незакрытый onboarding-код гасятся немедленно.
    revoke(id) {
      const r = db.prepare(
        "UPDATE machines SET agent_token_hash=NULL, onboarding_code_hash=NULL, revoked_at=? WHERE id=? AND revoked_at IS NULL"
      ).run(nowIso(), id);
      return r.changes === 1;
    },

    delete(id) {
      return db.prepare('DELETE FROM machines WHERE id = ?').run(id).changes === 1;
    },

    // pin === null снимает PIN; иначе хешируем как пароль.
    setPin(id, pin) {
      if (pin == null) {
        return db.prepare('UPDATE machines SET pin_hash=NULL WHERE id=?').run(id).changes === 1;
      }
      return db.prepare('UPDATE machines SET pin_hash=? WHERE id=?').run(hashPassword(String(pin)), id).changes === 1;
    },

    verifyPin(machineOrId, pin) {
      const row = typeof machineOrId === 'string' ? get(machineOrId) : machineOrId;
      if (!row || row.pin_hash == null) return false;
      try { return verifyPassword(String(pin), row.pin_hash); } catch { return false; }
    },

    // Асинхронный вариант для пути запроса claim: scrypt не блокирует event loop.
    async verifyPinAsync(machineOrId, pin) {
      const row = typeof machineOrId === 'string' ? get(machineOrId) : machineOrId;
      if (!row || row.pin_hash == null) return false;
      return verifyPasswordAsync(String(pin), row.pin_hash);
    },

    machineByToken(token) {
      if (typeof token !== 'string' || !token) return null;
      return db.prepare(
        'SELECT * FROM machines WHERE agent_token_hash = ? AND revoked_at IS NULL'
      ).get(sha256(token)) || null;
    },

    // heartbeat агента. inventory — результат sanitizeInventory: объект
    // перезаписывает прошлый, null (мусор) и отсутствие поля (undefined)
    // старый инвентарь сохраняют.
    touch(id, { inventory } = {}) {
      if (inventory === undefined || inventory === null) {
        return db.prepare(
          'UPDATE machines SET last_seen_at=? WHERE id=? AND agent_token_hash IS NOT NULL'
        ).run(nowIso(), id).changes === 1;
      }
      return db.prepare(
        'UPDATE machines SET last_seen_at=?, inventory=? WHERE id=? AND agent_token_hash IS NOT NULL'
      ).run(nowIso(), JSON.stringify(inventory), id).changes === 1;
    },
  };
}
