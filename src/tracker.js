/**
 * MediaPipe Hand Landmarker wrapper (runs fully on-device via WebAssembly,
 * GPU-accelerated through WebGL when available). No video ever leaves the
 * browser.
 */

export const MEDIAPIPE_VERSION = '0.10.21';
const CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}`;
export const VISION_BUNDLE_URL = `${CDN}/vision_bundle.mjs`;
export const WASM_URL = `${CDN}/wasm`;
export const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

export class HandTracker {
  constructor() {
    this.landmarker = null;
    this.delegate = null;
    this.lastTimestamp = -1;
  }

  /** @param {(msg:string)=>void} log */
  async init(log = () => {}, { numHands = 2, preferGPU = true } = {}) {
    log('Loading vision runtime');
    const vision = await import(/* webpackIgnore: true */ VISION_BUNDLE_URL);
    const { FilesetResolver, HandLandmarker } = vision;
    log('Compiling WebAssembly');
    const fileset = await FilesetResolver.forVisionTasks(WASM_URL);

    const options = (delegate) => ({
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: 'VIDEO',
      numHands,
      minHandDetectionConfidence: 0.6,
      minHandPresenceConfidence: 0.6,
      minTrackingConfidence: 0.5,
    });

    log('Loading hand landmark model');
    if (preferGPU) {
      try {
        this.landmarker = await HandLandmarker.createFromOptions(fileset, options('GPU'));
        this.delegate = 'GPU';
        return this;
      } catch (err) {
        console.warn('GPU delegate unavailable, falling back to CPU', err);
        log('GPU unavailable, using CPU');
      }
    }
    this.landmarker = await HandLandmarker.createFromOptions(fileset, options('CPU'));
    this.delegate = 'CPU';
    return this;
  }

  /**
   * Run detection on the current video frame.
   * @returns {{ hands: { landmarks: {x:number,y:number,z:number}[], handedness: string, score: number }[] }}
   */
  detect(video, timestamp) {
    // MediaPipe requires strictly increasing timestamps in VIDEO mode.
    const ts = Math.max(timestamp, this.lastTimestamp + 1);
    this.lastTimestamp = ts;
    const result = this.landmarker.detectForVideo(video, ts);
    const handedness = result.handedness || result.handednesses || [];
    return {
      hands: result.landmarks.map((landmarks, i) => ({
        landmarks,
        handedness: handedness[i]?.[0]?.categoryName ?? 'Unknown',
        score: handedness[i]?.[0]?.score ?? 0,
      })),
    };
  }
}
