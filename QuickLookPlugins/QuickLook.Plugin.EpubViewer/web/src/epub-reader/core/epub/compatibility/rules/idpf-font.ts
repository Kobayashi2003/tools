import {
  deobfuscateIdpfFont,
  IDPF_FONT_OBFUSCATION,
} from '../../resources/encryption';
import type { BinaryResourceCompatibilityRule } from '../resource-runner';

export const IDPF_FONT_COMPATIBILITY_ID = 'epub.resource.idpf-font';

export const idpfFontCompatibilityRule: BinaryResourceCompatibilityRule = {
  id: IDPF_FONT_COMPATIBILITY_ID,
  family: 'resource',
  stage: 'resource.binary',
  revision: '1',
  enabledByDefault: true,
  applies: (context) => context.encryptionAlgorithm === IDPF_FONT_OBFUSCATION,
  async apply(context, bytes) {
    return {
      value: await deobfuscateIdpfFont(bytes, context.publication),
      diagnostics: [
        {
          code: 'RESOURCE_IDPF_FONT_DEOBFUSCATED',
          severity: 'info',
          phase: 'compatibility',
          path: context.path,
          message: `Decoded IDPF-obfuscated font resource ${context.path}.`,
          repair: {
            strategy: 'deobfuscate-idpf-font',
            description:
              'Apply the standard IDPF font deobfuscation transform using the package unique identifier.',
            confidence: 1,
          },
        },
      ],
    };
  },
};
