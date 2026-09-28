import { ApiClient, object, records, type Params } from './api.js';
import { InstagramError, required } from './errors.js';
import type { Job, Store } from './store.js';
import type { Data } from './types.js';

export type PublicationKind = 'image' | 'reel' | 'story' | 'carousel';
/** Every mutation is checkpointed first. Ambiguous writes can never be replayed automatically. */
export class Publisher {
  constructor(private api: ApiClient, private store: Store, private now = Date.now) {}
  async execute(job: Job, kind: PublicationKind): Promise<Data> {
    const input = job.input, data = job.data;
    const account = this.api.connection();
    const save = (phase: string) => this.store.updateJob(job.id, 'running', phase, data);
    const pending = () => {
      this.store.updateJob(job.id, 'processing', 'waiting', data);
      return { status: 'processing', job_id: job.id, next_check_at: new Date(Number(data.nextPollAt)).toISOString(),
        instruction: 'After next_check_at, repeat the identical publishing tool and arguments with this approval_id. Do not create another publication.' };
    };
    if (Number(data.nextPollAt ?? 0) > this.now()) return pending();
    if (!data.startedAt) {
      const limits = await this.api.request('GET', `/${account.accountId}/content_publishing_limit`, { fields: 'quota_usage,config' });
      const quota = records(limits.data)[0], config = object(quota?.config);
      if (typeof quota?.quota_usage === 'number' && typeof config.quota_total === 'number') {
        required(quota.quota_usage < config.quota_total, 'INSTAGRAM_PUBLISHING_LIMIT', 'Meta reports that the publishing quota is exhausted.');
      }
      data.startedAt = this.now();
      data.childIds = [];
      save('starting');
    }
    required(this.now() - Number(data.startedAt) < 24 * 60 * 60_000, 'INSTAGRAM_CONTAINER_EXPIRED', 'The publishing workflow has reached the container lifetime. Reconcile it before approving a new action.');
    const ready = async (id: string): Promise<boolean> => {
      const status = await this.api.request('GET', `/${id}`, { fields: 'status_code' });
      const polls = Number(data.polls ?? 0) + 1;
      data.polls = polls;
      if (status.status_code === 'FINISHED') { delete data.nextPollAt; data.polls = 0; return true; }
      if (status.status_code === 'ERROR') throw new InstagramError('INSTAGRAM_CONTAINER_FAILED', 'Meta failed to process the media. Check the source URL and media specifications.');
      if (status.status_code === 'EXPIRED') throw new InstagramError('INSTAGRAM_CONTAINER_EXPIRED', 'The Meta container has expired.');
      if (status.status_code === 'PUBLISHED') throw new InstagramError('INSTAGRAM_OUTCOME_UNKNOWN', 'Meta reports that this container was already published. Reconcile the account media before another action.');
      required(status.status_code === 'IN_PROGRESS', 'INSTAGRAM_UPSTREAM_ERROR', 'Meta returned an unrecognized container status.');
      required(polls < 6, 'INSTAGRAM_PROCESSING_TIMEOUT', 'Meta processing has not finished after five minutes. Inspect the container before approving a new publication.');
      data.nextPollAt = this.now() + 60_000;
      return false;
    };
    const create = async (params: Params, phase: string): Promise<string> => {
      save(phase);
      const result = await this.api.request('POST', `/${account.accountId}/media`, params);
      required(typeof result.id === 'string' && /^\d+$/.test(result.id), 'INSTAGRAM_OUTCOME_UNKNOWN', 'Meta did not return a usable container ID. Do not retry this write blindly.');
      return result.id;
    };
    if (kind === 'carousel' && !data.containerId) {
      const children = data.childIds as string[];
      const items = input.items as { type: 'image' | 'video'; url: string }[];
      while (children.length < items.length) {
        if (!data.currentChild) {
          const item = items[children.length]!;
          data.currentChild = await create(item.type === 'image'
            ? { image_url: item.url, is_carousel_item: true }
            : { video_url: item.url, media_type: 'VIDEO', is_carousel_item: true }, 'creating_child');
          data.polls = 0;
          save('waiting_child');
        }
        if (!await ready(String(data.currentChild))) return pending();
        children.push(String(data.currentChild));
        delete data.currentChild;
        save('child_finished');
      }
    }
    if (!data.containerId) {
      let params: Params;
      if (kind === 'image') params = { image_url: String(input.image_url) };
      else if (kind === 'reel') params = { media_type: 'REELS', video_url: String(input.video_url), share_to_feed: input.share_to_feed as boolean | undefined };
      else if (kind === 'story') params = { media_type: 'STORIES', [input.type === 'image' ? 'image_url' : 'video_url']: String(input.url) };
      else params = { media_type: 'CAROUSEL', children: (data.childIds as string[]).join(',') };
      if (kind !== 'story' && input.caption !== undefined) params.caption = String(input.caption);
      if (input.is_ai_generated !== undefined) params.is_ai_generated = Boolean(input.is_ai_generated);
      data.containerId = await create(params, 'creating_container');
      data.polls = 0;
      save('waiting_container');
    }
    if (!await ready(String(data.containerId))) return pending();
    save('publishing');
    const result = await this.api.request('POST', `/${account.accountId}/media_publish`, { creation_id: String(data.containerId) });
    required(typeof result.id === 'string' && /^\d+$/.test(result.id), 'INSTAGRAM_OUTCOME_UNKNOWN', 'Meta did not return a publication ID. Check account media before another publishing attempt.');
    return { status: 'published', media: { id: result.id }, job_id: job.id };
  }
}
