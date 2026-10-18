// Preserve the renderer leaf's existing API while sharing the engine-wide
// ownership primitive used by controlled extension lifecycles.
export { LifecycleScope, type Cleanup } from '../../extension/lifecycle-scope';
