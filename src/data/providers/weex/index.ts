// Public entry for the from-scratch WEEX data provider, published as the
// `vela/providers/weex` subpath. No provider is bundled into the main
// entry — register this one explicitly:
//   import { WeexProvider } from 'vela/providers/weex';
//   chart.data.registerProvider('weex', new WeexProvider());
export { WeexProvider } from './WeexProvider';
export type { SymbolDescriptor, ProviderInfo, DataProvider } from '../../../core/ports/DataProvider';
