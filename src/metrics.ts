import { InstagramError } from './errors.js';
export const ACCOUNT_METRICS = ['accounts_engaged','comments','follows_and_unfollows','likes','profile_links_taps','reach','replies','reposts','saves','shares','total_interactions','views'] as const;
export const MEDIA_METRICS: Record<string, readonly string[]> = {
  FEED: ['comments','follows','likes','profile_activity','profile_visits','reach','reposts','saved','shares','total_interactions','views','total_comments','total_likes','total_views'],
  REELS: ['comments','likes','reach','reposts','saved','shares','total_interactions','views','ig_reels_avg_watch_time','ig_reels_video_view_total_time','reels_skip_rate','total_comments','total_likes','total_views'],
  STORY: ['follows','link_clicks','navigation','profile_activity','profile_visits','reach','replies','reposts','shares','total_interactions','views','total_views'],
};
export function checkMetrics(requested: string[], allowed: readonly string[]) {
  const invalid = requested.filter(m => !allowed.includes(m));
  if (invalid.length) throw new InstagramError('INSTAGRAM_UNSUPPORTED_METRIC', `Unsupported metrics: ${invalid.join(', ')}.`, { supported_metrics: allowed });
}
