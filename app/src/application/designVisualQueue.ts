import type { RoomBlueprint, RoomMetrics } from '../domain/game/state';

export type DesignVisualRequest = { kind:'master' } | { kind:'focus'; focus:string };
export interface DesignVisualProvider { generate(room:RoomBlueprint, request:DesignVisualRequest):Promise<{assetPath:string}> }
export type DesignVisualResult = { status:'complete'; assets:Array<{request:DesignVisualRequest;assetPath:string}>; errors:Array<{request:DesignVisualRequest;message:string;retryable:true}>; economics:RoomMetrics };

function validAsset(path:string) { return path.startsWith('/visuals/') && !path.includes('..') && !path.toLowerCase().includes('base64'); }

export class DesignVisualQueue {
  constructor(private provider:DesignVisualProvider, private concurrency=2) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('并发数必须是正整数');
  }
  async enqueue(room:RoomBlueprint, requests:DesignVisualRequest[]):Promise<DesignVisualResult> {
    const bounded=requests.slice(0,4), assets:DesignVisualResult['assets']=[], errors:DesignVisualResult['errors']=[];
    let cursor=0;
    const workers=Array.from({length:Math.min(this.concurrency,bounded.length)},async()=>{ while(cursor<bounded.length){ const request=bounded[cursor++]; try { const result=await this.provider.generate(structuredClone(room),structuredClone(request)); if(!validAsset(result.assetPath)) throw new Error('效果图路径无效'); assets.push({request,assetPath:result.assetPath}); } catch(error) { errors.push({request,message:error instanceof Error?error.message:'效果图生成失败',retryable:true}); } } });
    await Promise.all(workers);
    return { status:'complete', assets, errors, economics:structuredClone(room.metrics) };
  }
}
