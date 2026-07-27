import type { RoomBlueprint, RoomMetrics, PersistedDesignVisuals } from '../domain/game/state';

export type { DesignVisualRequest } from '../domain/game/state';
import type { DesignVisualRequest } from '../domain/game/state';
export interface DesignVisualProvider { generate(room:RoomBlueprint, request:DesignVisualRequest):Promise<{assetPath:string}> }
export type DesignVisualResult = PersistedDesignVisuals & { economics:RoomMetrics };

function validAsset(path:string) { return path.startsWith('/visuals/') && !path.includes('..') && !path.toLowerCase().includes('base64'); }

export class DesignVisualQueue {
  constructor(private provider:DesignVisualProvider, private concurrency=2) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('并发数必须是正整数');
  }
  async enqueue(room:RoomBlueprint, requests:DesignVisualRequest[]):Promise<DesignVisualResult> {
    const seen = new Set<string>();
    let focusCount = 0;
    const bounded = requests.flatMap((request): DesignVisualRequest[] => {
      const normalized = request.kind === 'master'
        ? request
        : { kind: 'focus' as const, focus: request.focus.trim() };
      const key = normalized.kind === 'master' ? 'master' : `focus:${normalized.focus}`;
      if (
        seen.has(key) ||
        (normalized.kind === 'focus' && (!normalized.focus || focusCount >= 3))
      ) return [];
      seen.add(key);
      if (normalized.kind === 'focus') focusCount += 1;
      return [normalized];
    });
    const completed: Array<{
      index: number;
      asset?: DesignVisualResult['assets'][number];
      error?: DesignVisualResult['errors'][number];
    }> = [];
    let cursor=0;
    const workers=Array.from({length:Math.min(this.concurrency,bounded.length)},async()=>{ while(cursor<bounded.length){ const index=cursor++; const request=bounded[index]; try { const result=await this.provider.generate(structuredClone(room),structuredClone(request)); if(!validAsset(result.assetPath)) throw new Error('效果图路径无效'); completed.push({index,asset:{request,assetPath:result.assetPath}}); } catch(error) { completed.push({index,error:{request,message:error instanceof Error?error.message:'效果图生成失败',retryable:true}}); } } });
    await Promise.all(workers);
    completed.sort((left, right) => left.index - right.index);
    const assets = completed.flatMap((item) => item.asset ? [item.asset] : []);
    const errors = completed.flatMap((item) => item.error ? [item.error] : []);
    return { status:'complete', assets, errors, economics:structuredClone(room.metrics) };
  }
}
