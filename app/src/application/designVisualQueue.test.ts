import { describe, expect, it } from 'vitest';
import { DesignVisualQueue } from './designVisualQueue';
import type { RoomBlueprint } from '../domain/game/state';

const room: RoomBlueprint = { id:'room', name:'客房', columns:8, rows:12, cells:[], metrics:{areaSquareMeters:24,buildCostCents:100,suggestedRateCents:200,businessFitBps:8000}, visual:{status:'idle'} };

describe('DesignVisualQueue', () => {
  it('queues a master plus up to three focus images without changing economics', async () => {
    let active=0,maxActive=0;
    const queue=new DesignVisualQueue({ generate:async(_room,request)=>{ active++; maxActive=Math.max(maxActive,active); await Promise.resolve(); active--; return {assetPath:`/visuals/${request.kind}.png`}; } },2);
    const before=structuredClone(room);
    const result=await queue.enqueue(room,[{kind:'master'},{kind:'focus',focus:'bathroom'},{kind:'focus',focus:'lighting'},{kind:'focus',focus:'view'},{kind:'focus',focus:'extra'}]);
    expect(result.assets).toHaveLength(4);
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(room).toEqual(before);
    expect(result.economics).toEqual(before.metrics);
  });

  it('returns retryable errors and rejects unsafe asset namespaces', async () => {
    const failed=new DesignVisualQueue({generate:async()=>{throw new Error('网络暂不可用');}});
    expect((await failed.enqueue(room,[{kind:'master'}])).errors[0]).toMatchObject({retryable:true,message:'网络暂不可用'});
    const unsafe=new DesignVisualQueue({generate:async()=>({assetPath:'data:image/png;base64,x'})});
    expect((await unsafe.enqueue(room,[{kind:'master'}])).errors[0]?.message).toBe('效果图路径无效');
  });
});
