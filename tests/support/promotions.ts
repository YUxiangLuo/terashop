import { api, checked, onlyRow } from '../helpers';
import type { Cleanup } from './cleanup';

export const disablePromotion = (id: string) => checked(api(`/rest/v1/promotions?id=eq.${id}`, {
  service: true, method: 'PATCH', body: { is_active: false },
}));

export async function promotionFixture(cleanup: Cleanup, body: Record<string, unknown>): Promise<string> {
  const row = await onlyRow<{ id: string }>(api('/rest/v1/promotions?select=id', {
    service: true, method: 'POST', body,
  }));
  // Orders may reference this rule: DELETE is not a valid general cleanup.
  cleanup.defer(() => disablePromotion(row.id));
  return row.id;
}
