import { object, records } from './api.js';
import type { Data } from './types.js';
export function pick(value: unknown, fields: readonly string[]): Data {
  const source = object(value), result: Data = {};
  for (const key of fields) if (source[key] !== undefined) result[key] = source[key];
  return result;
}
export const MEDIA_FIELDS = 'id,caption,media_type,media_product_type,media_url,permalink,thumbnail_url,timestamp,username,comments_count,like_count,children{id,media_type,media_url,thumbnail_url}';
export const media = (v: unknown): Data => {
  const result = pick(v, ['id','caption','media_type','media_product_type','media_url','permalink','thumbnail_url','timestamp','username','comments_count','like_count']);
  if (object(v).children) result.children = records(object(object(v).children).data).map(child => pick(child, ['id','media_type','media_url','thumbnail_url']));
  return result;
};
export const comment = (v: unknown) => pick(v, ['id','text','timestamp','username','like_count','hidden','parent_id']);
export function page(data: Data, normalize: (v: unknown) => Data, cursorOnly = false): Data {
  const paging = object(data.paging), cursors = object(paging.cursors);
  const hasNext = Boolean((cursorOnly ? cursors.after : paging.next) && cursors.after);
  return { items: records(data.data).map(normalize), paging: { has_next_page: hasNext, ...(hasNext ? {cursor: cursors.after} : {}) } };
}
export const insights = (data: Data) => ({ metrics: records(data.data).map(v => pick(v, ['name','period','title','description','values','total_value'])), empty_means: 'unavailable_or_no_data; not zero' });
