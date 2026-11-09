// Pinned third-party assets, fetched once and kept by the service worker (sw.js).
const ORT = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/';
export const ORT_DIST = ORT;
export const ORT_URL = { webgpu: ORT + 'ort.webgpu.min.mjs', wasm: ORT + 'ort.wasm.min.mjs' };
const HF = 'https://huggingface.co/PaddlePaddle/';
export const MODELS = {
  det: HF + 'PP-OCRv5_mobile_det_onnx/resolve/e6f4fa85f00e168c862bc462aebca69eef9b3d3d/inference.onnx',
  rec: HF + 'PP-OCRv5_mobile_rec_onnx/resolve/ed152b8b495f84de93cda5709d768548a9127622/inference.onnx',
  recYml: HF + 'PP-OCRv5_mobile_rec_onnx/resolve/ed152b8b495f84de93cda5709d768548a9127622/inference.yml',
};
