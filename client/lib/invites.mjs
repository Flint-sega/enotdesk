// Статус приглашения для UI: использованные/отозванные/истёкшие не дают
// кнопку «Отозвать» (серверный DELETE по ним отвечает 404).

export function inviteStatus(inv, now = new Date()) {
  if (inv.usedAt) return { state: 'used', label: 'использовано' };
  if (inv.revokedAt) return { state: 'revoked', label: 'отозвано' };
  if (new Date(inv.expiresAt).getTime() <= now.getTime()) return { state: 'expired', label: 'истекло' };
  return { state: 'active', label: `действует до ${new Date(inv.expiresAt).toLocaleString('ru')}` };
}
