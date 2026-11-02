import { mergeConfig } from 'vitest/config'
import viteConfig from './vite.config.ts'

export default mergeConfig(
  viteConfig,
  {
    test: {
      globals: true,
      environment: 'node',
      include: ['tests/**/*.test.ts'],
      testTimeout: 180000,
      hookTimeout: 180000,
      transformMode: {
        web: [
          'tests/resource-cleanup.test.ts',
          'tests/editor-controller.test.ts',
          'tests/editor-export.test.ts',
          'tests/recording-audio.test.ts',
        ],
      },
      coverage: {
        provider: 'v8',
        reporter: ['text', 'html'],
        include: ['src/lib/**/*.ts'],
      },
    },
  },
)