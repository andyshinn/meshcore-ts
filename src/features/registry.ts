import type { Feature } from './feature';

/** Maps inbound companion wire codes to the feature that handles them, so the
 *  session's onPacket can dispatch instead of switching. */
export class FeatureRegistry {
  private readonly byCode = new Map<number, Feature>();

  constructor(features: readonly Feature[]) {
    for (const feature of features) {
      for (const code of feature.handles) {
        if (this.byCode.has(code)) {
          throw new Error(`duplicate feature handler for code 0x${code.toString(16).padStart(2, '0')}`);
        }
        this.byCode.set(code, feature);
      }
    }
  }

  get(code: number): Feature | undefined {
    return this.byCode.get(code);
  }
}
